"""asys-bpmn-convert: move BPMN workflows to workflow files.

Every BPMN workflow under a directory is converted to a workflow file beside
it, with the same name and .yaml, and validated. The BPMN stays where it is
and keeps running. Nothing else is edited: files that still mention BPMN,
such as tests, documentation and skills, are listed for a person to change.
"""
from pathlib import Path
import re

from . import flow
from .flow_convert import convert

SKIPPED = {'.git', 'node_modules', '__pycache__', '.venv', '.asys', '.asys-runtime'}
TEXT = {'.md', '.py', '.mjs', '.js', '.ts', '.json', '.yaml', '.yml', '.sh', '.txt', '.toml', ''}


def files(root, suffixes=None):
    for path in sorted(root.rglob('*')):
        if any(part in SKIPPED for part in path.relative_to(root).parts):
            continue
        if path.is_file() and not path.name.endswith('~') and (suffixes is None or path.suffix in suffixes):
            yield path


def migrate(root, environment=None, write=True, force=False, report=print):
    """Convert, validate and report; True when every workflow converted and validates."""
    root = Path(root).expanduser().resolve()
    if root.is_file():   # one workflow: convert it, and report on nothing else
        workflows, root, single = [root], root.parent, True
    else:
        workflows, single = list(files(root, {'.bpmn'})), False
    if not workflows:
        report(f'No BPMN workflows under {root}.')
        return True
    clean = True
    for source in workflows:
        target = source.with_suffix('.yaml')
        relative = source.relative_to(root)
        text, result = convert(source.read_text(encoding='utf-8'))
        if text is None:
            clean = False
            report(f'{relative}: not converted')
            for problem in result.problems:
                report(f'    {problem}')
            continue
        if target.exists() and not force and target.read_text(encoding='utf-8') != text:
            clean = False
            report(f'{relative}: {target.name} exists and differs; --force replaces it')
            continue
        if write:
            target.write_text(text, encoding='utf-8')
        problems = flow.check(flow.load_all(target), environment) if write else []
        verb = 'converted to' if write else 'would convert to'
        report(f'{relative}: {verb} {target.relative_to(root)}' + ('' if not problems else f', {len(problems)} problem(s)'))
        for note in result.notes:
            report(f'    note: {note}')
        for problem in problems:
            clean = False
            report(f'    {problem["at"]}: {problem["message"]}' if problem.get('at') else f'    {problem["message"]}')
    if single:
        return clean
    # What a person still has to change: everything else that talks about BPMN.
    mentions = []
    for path in files(root, TEXT):
        if path.suffix in {'.bpmn'} or path.with_suffix('.bpmn').exists() and path.suffix == '.yaml':
            continue
        try:
            lines = path.read_text(encoding='utf-8').splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        found = [number for number, line in enumerate(lines, 1) if re.search(r'bpmn', line, re.IGNORECASE)]
        if found:
            mentions.append((path.relative_to(root), found))
    if mentions:
        report('')
        report('Still mention BPMN (not edited; tests that load workflow.bpmn keep testing the BPMN):')
        for path, lines in mentions:
            shown = ', '.join(map(str, lines[:6])) + (', ...' if len(lines) > 6 else '')
            report(f'    {path}: line{"s" if len(lines) > 1 else ""} {shown}')
    return clean


def main(argv=None):
    import argparse
    import os
    parser = argparse.ArgumentParser(
        prog='asys-bpmn-convert', allow_abbrev=False,
        description='Convert BPMN workflows to workflow files (asys: workflow/1). Each FILE.bpmn, or every .bpmn '
                    'under a DIRECTORY, gets FILE.yaml beside it, validated; the BPMN is left as it is. Files that '
                    'still mention BPMN are listed, not edited.')
    parser.add_argument('paths', nargs='*', type=Path, metavar='FILE.bpmn|DIRECTORY', default=[Path('.')])
    parser.add_argument('--environment', type=Path, metavar='DIRECTORY',
                        default=os.environ.get('ASYS_ENVIRONMENT_DIR') or None,
                        help='validate worker types against this environment (default: $ASYS_ENVIRONMENT_DIR)')
    parser.add_argument('--dry-run', action='store_true', help='report what would be converted; write nothing')
    parser.add_argument('--force', action='store_true', help='replace workflow files that already exist and differ')
    args = parser.parse_args(argv)
    clean = True
    for path in args.paths:
        if not path.exists():
            print(f'asys-bpmn-convert: {path}: no such file or directory')
            clean = False
            continue
        clean &= migrate(path, args.environment, write=not args.dry_run, force=args.force)
    return 0 if clean else 1
