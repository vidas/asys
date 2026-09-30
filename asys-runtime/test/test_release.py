import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from asys_runtime import release  # noqa: E402


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="asys-release-"))
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(self.root)], check=True))
        self.images = {"asys-runtime:1.0-abc": "sha256:runtime", "asys-workers:1.0-abc": "sha256:workers"}
        inspect = patch.object(release, "inspect_image", side_effect=lambda ref: self.images[ref])
        inspect.start()
        self.addCleanup(inspect.stop)
        self.path = self.root / "release.json"
        for name in ("asys-runtime", "asys-workers"):
            release.record(self.path, name, f"{name}:1.0-abc", version="1.0", build="1.0-abc")

    def test_a_build_records_each_image_by_tag_and_id(self):
        installed = release.load(self.path)
        self.assertEqual((installed["version"], installed["build"]), ("1.0", "1.0-abc"))
        self.assertEqual(installed["images"]["asys-workers"],
                         {"ref": "asys-workers:1.0-abc", "id": "sha256:workers", "build": "1.0-abc"})
        self.assertEqual(release.image("asys-workers", installed), ("asys-workers:1.0-abc", "sha256:workers"))

    def test_a_moved_tag_is_refused_instead_of_used(self):
        installed = release.load(self.path)
        self.images["asys-workers:1.0-abc"] = "sha256:another-build"
        with self.assertRaisesRegex(release.ReleaseError, "no longer names"):
            release.image("asys-workers", installed)
        with self.assertRaisesRegex(release.ReleaseError, "has no asys-bpmn"):
            release.image("asys-bpmn", installed)

    def test_bases_resolve_by_bare_and_legacy_names_to_the_release(self):
        arguments = release.build_contexts(release.load(self.path))
        contexts = dict(value.split("=", 1) for value in arguments[1::2])
        self.assertEqual(set(arguments[0::2]), {"--build-context"})
        self.assertEqual(contexts, {
            "asys-runtime": "docker-image://asys-runtime:1.0-abc",
            "asys-runtime:dev": "docker-image://asys-runtime:1.0-abc",
            "asys-workers": "docker-image://asys-workers:1.0-abc",
            "asys-workers:dev": "docker-image://asys-workers:1.0-abc",
        })

    def test_only_old_asys_base_spellings_are_reported(self):
        dockerfile = self.root / "Dockerfile"
        dockerfile.write_text("FROM --platform=linux/amd64 asys-workers:dev AS base\nFROM asys-runtime\n"
                              "FROM ubuntu:dev\nRUN echo FROM asys-worlds:dev\n")
        self.assertEqual(release.legacy_bases(dockerfile), ["asys-workers:dev"])

    def test_a_checkout_uses_its_own_release_and_never_another_checkouts(self):
        checkout = self.root / "checkout"
        module = checkout / "asys-runtime/asys_runtime/release.py"
        module.parent.mkdir(parents=True)
        (checkout / "VERSION").write_text("1.0\n")
        (self.root / "release.json").write_text("{}")  # an enclosing checkout's build
        with patch.object(release, "__file__", str(module)), patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(release.ReleaseError, "No asys release found"):
                release.release_path()
            (checkout / "release.json").write_text("{}")
            self.assertEqual(release.release_path(), checkout / "release.json")

    def test_component_packages_find_the_installation_beside_them(self):
        prefix = self.root / "prefix"
        module = prefix / "share/asys-human/python/asys_runtime/release.py"
        module.parent.mkdir(parents=True)
        installed = prefix / "share/asys/release.json"
        installed.parent.mkdir(parents=True)
        installed.write_text("{}")
        with patch.object(release, "__file__", str(module)), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(release.release_path(), installed)
        with patch.dict(os.environ, {"ASYS_RELEASE": str(self.path)}):
            self.assertEqual(release.release_path(), self.path)


if __name__ == "__main__":
    unittest.main()
