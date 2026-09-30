"""Report which asys release is installed and which one each running service uses."""
import json
from pathlib import Path
import shutil
import subprocess

from asys_runtime import release

from .update import inference_command


def version(args):
    try:
        path = release.release_path()
        installed = release.load(path)
    except (release.ReleaseError, OSError, ValueError) as error:
        print(f'asys: no release information ({error})')
        return
    warnings = []
    print(f"asys {installed['version']} (build {installed['build']})")
    print(f'release   {path}')
    print(f'state     {args.root}')

    width = max([len(entry['ref']) for entry in installed['images'].values()] + [30]) + 2
    print('images')
    for name in sorted(installed['images']):
        entry = installed['images'][name]
        try:
            release.image(name, installed)
            state = 'ok'
        except release.ReleaseError as error:
            state = 'unavailable'
            warnings.append(str(error))
        print(f"  {name:<22} {entry['ref']:<{width}}{state}")

    print('services')
    services = (inference_services(Path(args.root), installed, warnings, width)
                + human_services(Path(args.root), installed, warnings, width))
    for line in services or ['  none running in this state']:
        print(line)

    command = shutil.which('asys-inference')
    expected = Path(inference_command()).resolve()
    if command and Path(command).resolve() != expected:
        warnings.append(f'PATH runs {command}, not this release\'s {expected}; remove or reorder the other copy')

    for warning in warnings:
        print(f'warning: {warning}')


def inference_services(root, installed, warnings, width):
    path = root / 'inference/machine.json'
    try:
        document = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    lines = []
    for component in (document.get('applied') or {}).get('components', []):
        name = component['name']
        build = image_build(component['component']['image'])
        current = build == installed['build']
        lines.append(f"  {name:<22} {build or 'built before release identity':<{width}}{'current' if current else 'outdated'}")
        if not current:
            warnings.append(f'{name} was not built by release {installed["build"]}; run asys update')
    if document.get('revision') != document.get('applied_revision'):
        warnings.append('inference has configuration changes that are not applied; run asys-inference start')
    return lines


def human_services(root, installed, warnings, width):
    expected = installed['images'].get('asys-human-interface', {}).get('id')
    lines = []
    for path in sorted((root / 'human').glob('*/service.json')):
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        name = record.get('component', path.parent.name)
        current = record.get('image') == expected
        build = image_build(record.get('image', '')) or 'built before release identity'
        lines.append(f"  {name:<22} {build:<{width}}{'current' if current else 'outdated'}")
        if not current:
            warnings.append(f'{name} does not run release {installed["build"]}; run asys update')
    return lines


def image_build(image):
    result = subprocess.run(['docker', 'image', 'inspect', '--format', '{{index .Config.Labels "io.asys.build"}}', image],
                            capture_output=True, text=True)
    label = result.stdout.strip() if result.returncode == 0 else ''
    return '' if label in ('', '<no value>') else label
