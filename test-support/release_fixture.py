"""A release manifest for host tests whose fake docker reports one image ID."""
import json
import os
from pathlib import Path
from unittest.mock import patch

IMAGES = ("asys-runtime", "asys-workers", "asys-worlds", "asys-bpmn", "asys-human-interface")


def use_fixture_release(test, directory, image):
    """Select a release in DIRECTORY whose images all inspect as IMAGE."""
    path = Path(directory) / "release.json"
    path.write_text(json.dumps({"version": "0.0.0", "build": "fixture", "images": {
        name: {"ref": f"{name}:fixture", "id": image, "build": "fixture"} for name in IMAGES}}))
    selection = patch.dict(os.environ, {"ASYS_RELEASE": str(path)})
    selection.start()
    test.addCleanup(selection.stop)
    return path
