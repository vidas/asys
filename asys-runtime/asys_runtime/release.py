# SPDX-License-Identifier: MIT
"""Release identity: the version, build and images one asys build produced.

`make build` records every image it tags in release.json at the checkout root;
`make install` copies that file to PREFIX/share/asys. Host tools take their
images from it, never from a mutable tag, so building another checkout does
not change what an installation runs.
"""

import json
import os
from pathlib import Path
import subprocess

from .files import read_json, write_json

RELEASE_FILE = "release.json"
# Images environment and world Dockerfiles build FROM, by bare name.
BASES = ("asys-runtime", "asys-workers", "asys-worlds")
# Spelling used before release identity; still resolved so existing
# environments build unchanged.
LEGACY_TAG = "dev"
# Image labels; images built FROM an asys base inherit them.
BUILD_LABEL = "io.asys.build"
INFERENCE_LABEL = "io.asys.inference-format"


class ReleaseError(RuntimeError):
    pass


def release_path():
    explicit = os.environ.get("ASYS_RELEASE")
    if explicit:
        return Path(explicit)
    # A checkout keeps release.json at its root, an installation at
    # PREFIX/share/asys; component packages live beside it under PREFIX/share.
    for directory in Path(__file__).resolve().parents:
        for candidate in (directory / RELEASE_FILE, directory / "share/asys" / RELEASE_FILE):
            if candidate.is_file():
                return candidate
        if (directory / "VERSION").is_file():
            break  # never borrow another checkout's build
    raise ReleaseError("No asys release found; build it with make build or install it with make install")


def load(path=None):
    path = Path(path) if path is not None else release_path()
    release = read_json(path)
    if not isinstance(release, dict) or not isinstance(release.get("images"), dict):
        raise ReleaseError(f"{path} is not an asys release")
    return release


def image(name, release=None, inspect=None):
    """Return NAME's (tag, image ID) in the release, verifying the tag still names it.

    INSPECT maps an image reference to its ID; hosts pass their command runner.
    """
    release = release if release is not None else load()
    inspect = inspect or inspect_image
    entry = release["images"].get(name)
    if not entry:
        raise ReleaseError(f"Release {release.get('build', '?')} has no {name} image; rebuild with make build")
    actual = inspect(entry["ref"])
    if actual != entry["id"]:
        raise ReleaseError(f"{entry['ref']} no longer names the image of release {entry['build']}; "
                           "reinstall asys or rebuild with make build")
    return entry["ref"], actual


def build_contexts(release=None, inspect=None):
    """docker build arguments resolving asys base images to this release."""
    release = release if release is not None else load()
    arguments = []
    for name in BASES:
        if name in release["images"]:
            ref, _ = image(name, release, inspect)
            for spelling in (name, f"{name}:{LEGACY_TAG}"):
                arguments += ["--build-context", f"{spelling}=docker-image://{ref}"]
    return arguments


def legacy_bases(dockerfile):
    """Base images a Dockerfile names with the old :dev tag."""
    names = []
    for line in Path(dockerfile).read_text(encoding="utf-8").splitlines():
        words = line.split()
        if len(words) >= 2 and words[0].upper() == "FROM":
            reference = next((word for word in words[1:] if not word.startswith("--")), "")
            if reference in {f"{name}:{LEGACY_TAG}" for name in BASES}:
                names.append(reference)
    return names


def record(path, name, ref, *, version, build, interfaces=None):
    """Add NAME's freshly tagged image to the release at PATH.

    INTERFACES names the protocol versions this build speaks, such as the
    inference format; an update compares them with what running work uses.
    """
    path = Path(path)
    try:
        release = load(path)
    except FileNotFoundError:
        release = {"images": {}}
    release.update(version=version, build=build)
    if interfaces is not None:
        release["interfaces"] = interfaces
    release["images"][name] = {"ref": ref, "id": inspect_image(ref), "build": build}
    write_json(path, release, mode=0o644)
    return release


def inspect_image(ref):
    result = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", ref],
                            capture_output=True, text=True)
    if result.returncode:
        raise ReleaseError(f"Image {ref} is unavailable: {result.stderr.strip()}")
    return result.stdout.strip()


def image_labels(image):
    """Return an image's labels; images built before release identity have none."""
    result = subprocess.run(["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", image],
                            capture_output=True, text=True)
    if result.returncode:
        raise ReleaseError(f"Image {image} is unavailable: {result.stderr.strip()}")
    return json.loads(result.stdout) or {}
