"""Build environment and world images on the installed release's base images."""
from pathlib import Path

from asys_runtime import release

from .lifecycle import LaunchError


def build_image(host, source, iidfile):
    """Build SOURCE's Dockerfile and return the image ID.

    FROM asys-runtime, asys-workers and asys-worlds resolve to the installed
    release, whatever those names point to in Docker. Other bases build as
    written.
    """
    dockerfile = Path(source) / 'Dockerfile'
    for legacy in release.legacy_bases(dockerfile):
        host.say(f'{dockerfile}: FROM {legacy} is the old spelling; write FROM {legacy.partition(":")[0]}')
    try:
        contexts = release.build_contexts(inspect=host.image_id)
    except release.ReleaseError as error:
        raise LaunchError(str(error)) from error
    host.command(['docker', 'build', *contexts, '--iidfile', str(iidfile), str(source)],
                 timeout=900, cancellable=True)
    return Path(iidfile).read_text().strip()
