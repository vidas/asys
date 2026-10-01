"""Command-line parsing and dispatch for the asys host tools."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from .config import list_system_models, set_system_model
from .lifecycle import LaunchError
from .monitor import top
from .overview import overview
from .runs import logs, status
from .skill import skill
from .state import initialize, state_root
from .update import update
from .version import version
from .options import ROOT_HELP


def dashboard(args):
    from .dashboard import dashboard as serve
    return serve(args)


def check_workflow(args):
    from . import flow
    problems = []
    workflow = flow.load_all(args.file, problems)
    problems += flow.check(workflow, args.environment)
    if args.json:
        print(json.dumps(problems, indent=2))
    else:
        for problem in problems:
            print(problem)
        print(f'{args.file}: ' + ('valid' if not problems else f'{len(problems)} problem(s)'))
    if problems:
        raise SystemExit(1)


def serve_workflows(args):
    from .flow_service import serve
    serve()


def convert_workflow(args):
    from .flow_convert import convert
    text, result = convert(args.file.read_text(encoding='utf-8'), args.process)
    for note in result.notes:
        print(f'note: {note}', file=sys.stderr)
    for problem in result.problems:
        print(f'cannot convert: {problem}', file=sys.stderr)
    if text is None:
        raise SystemExit(1)
    if args.output is None:
        sys.stdout.write(text)
        return
    if args.output.exists() and not args.force:
        raise SystemExit(f'{args.output} exists; use --force to replace it')
    args.output.write_text(text, encoding='utf-8')
    print(f'Wrote {args.output}; check it with asys workflow check {args.output} --environment ENV', file=sys.stderr)


def system_or_run_status(args):
    return status(args) if args.run else overview(args)


def validate_dashboard(parser, args):
    if not 0 <= args.port <= 65535:
        parser.error('--port must be between 0 and 65535')


def root_options(description, default):
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument('--root', type=Path, metavar='DIRECTORY',
                        default=argparse.SUPPRESS, help=description)
    parser.set_defaults(root_default=default)
    return parser


def add_command(commands, name, handler, description, *, parents=(), validate=None):
    # argparse cannot intermix options and positionals when parsing subparsers.
    # Route to a command first, then parse its arguments with its own parser.
    route = commands.add_parser(name, help=description, add_help=False, allow_abbrev=False)
    parser = argparse.ArgumentParser(prog=route.prog, description=description,
                                     parents=parents, allow_abbrev=False)
    parser.set_defaults(handler=handler, validate=validate)
    route.set_defaults(argument_parser=parser, root_default=parser.get_default('root_default'))
    return parser


def validate_init(parser, args):
    if args.root is not None:
        parser.error('init takes its state directory as DIR, without --root')


def validate_skill(parser, args):
    if args.root is not None:
        parser.error('skill reads the installed bundle and does not use --root')


def validate_logs(parser, args):
    args.source = args.source or ('jobs' if args.job or args.stream else 'run')
    if args.lines is not None and args.lines < 0:
        parser.error('--lines must be nonnegative')
    if (args.job or args.stream) and args.source != 'jobs':
        parser.error('JOB and --stream are only valid with --source jobs')
    args.stream = args.stream or 'both'
    if args.source not in {'run', 'events'} and args.lines is None:
        args.lines = 50


def arguments(argv):
    parser = argparse.ArgumentParser(prog='asys', allow_abbrev=False,
        description='Configure asys, update shared services, and inspect runs and jobs.')
    parser.add_argument('--root', type=Path, metavar='DIRECTORY', default=argparse.SUPPRESS,
        help=ROOT_HELP)
    parser.set_defaults(argument_parser=None, root_default=None)
    commands = parser.add_subparsers(dest='command', title='commands', metavar='COMMAND')

    state = root_options(ROOT_HELP, state_root)

    init = add_command(commands, 'init', initialize, 'Initialize asys state', validate=validate_init)
    init.add_argument('directory', type=Path, metavar='DIR')
    init.add_argument('--dcomp', type=Path, metavar='DIR',
                      help='initialize or reuse this dcomp state directory (default: <asys directory>/dcomp)')
    init.add_argument('--group', metavar='GROUP', help='share new state with this Unix group')

    refresh = add_command(commands, 'update', update,
                          'Refresh running shared services from the installed images', parents=[state])
    refresh.add_argument('--force', action='store_true',
                         help='update even if active workflows predating upgrade handover would lose inference')

    add_command(commands, 'version', version,
                'Show the installed release and the release each running service uses', parents=[state])

    workflows = commands.add_parser('workflow', allow_abbrev=False,
        help='Check, edit and inspect workflow files',
        description='Check, edit and inspect workflow files (workflow/1 YAML).')
    operations = workflows.add_subparsers(dest='operation', required=True, metavar='COMMAND')
    checking = add_command(operations, 'check', check_workflow,
                           'Validate a workflow and the files it calls')
    checking.add_argument('file', type=Path, metavar='FILE')
    checking.add_argument('--environment', type=Path, metavar='DIRECTORY',
                          help='also check worker types, program arguments and human forms against this environment')
    checking.add_argument('--json', action='store_true', help='print problems as a JSON list')
    add_command(operations, 'serve', serve_workflows,
                'Edit workflows through JSON requests on stdin, one per line (used by viewers)')
    converting = add_command(operations, 'convert', convert_workflow,
                             'Write the workflow file a BPMN process corresponds to')
    converting.add_argument('file', type=Path, metavar='FILE.bpmn')
    converting.add_argument('-o', '--output', type=Path, metavar='FILE.yaml', help='write here instead of stdout')
    converting.add_argument('--process', metavar='ID', help='the executable process, when the file has several')
    converting.add_argument('--force', action='store_true', help='replace an existing output file')

    guide = add_command(commands, 'skill', skill,
                        'Locate or export the operating and authoring skills', validate=validate_skill)
    guide.add_argument('destination', nargs='?', type=Path, metavar='DEST',
                       help='parent skills directory; existing skill copies are preserved')
    guide.add_argument('--name', choices=['asys', 'asys-authoring'],
                       help='select one skill (default: both, with references and templates)')

    models = commands.add_parser('system-model', parents=[state], allow_abbrev=False,
        help='Set and list model defaults for system agents',
        description='Set and list model defaults for system agents.')
    operations = models.add_subparsers(dest='operation', required=True, metavar='COMMAND')
    setting = add_command(operations, 'set', set_system_model,
                          'Set the model for a system-model name', parents=[state])
    setting.add_argument('name', metavar='SYSTEM-MODEL')
    setting.add_argument('model', metavar='MODEL')
    listing = add_command(operations, 'list', list_system_models,
                          'List configured and unset system models', parents=[state])
    listing.add_argument('--json', action='store_true', help='print a JSON object mapping names to models')

    ps = add_command(commands, 'ps', status, 'List saved runs', parents=[state])
    ps.set_defaults(run=None)
    ps.add_argument('--json', action='store_true', help='print structured run and job status')

    run_help = 'run ID or unique prefix, latest, or a saved run directory'
    inspect = add_command(commands, 'status', system_or_run_status,
                          "Show whether the system and its services are running, or one run's jobs and errors",
                          parents=[state])
    inspect.add_argument('run', nargs='?', metavar='RUN',
                         help=run_help + '; omit it to show the system, its services and active runs')
    inspect.add_argument('--json', action='store_true', help='print structured status')

    output = add_command(commands, 'logs', logs, 'Show saved run output; JOB selects worker output',
                         parents=[state], validate=validate_logs)
    output.add_argument('run', nargs='?', metavar='RUN', help=run_help)
    output.add_argument('job', nargs='?', metavar='JOB', help='job name, ID, or unique ID prefix')
    output.add_argument('-f', '--follow', action='store_true', help='follow new output and jobs until the run ends')
    output.add_argument('-n', '--lines', type=int, metavar='N',
                        help='initial lines (default: full run log, 50 per worker log; 0 starts at the end)')
    output.add_argument('--stream', choices=['both', 'stdout', 'stderr'], help='select a worker output stream')
    output.add_argument('--source', choices=['run', 'events', 'jobs', 'components', 'commands'],
                        help='saved log source (default: run, or jobs when JOB is given)')

    monitor = add_command(commands, 'top', top, 'Monitor runs, jobs, and transcripts', parents=[state])
    monitor.add_argument('run', nargs='?', metavar='RUN', help=run_help)

    board = add_command(commands, 'dashboard', dashboard,
                        'Open the local dashboard for all systems in this state root',
                        parents=[state], validate=validate_dashboard)
    board.add_argument('--port', type=int, default=0,
                       help='local HTTP port (default: select an available port)')
    board.add_argument('--design', type=Path, metavar='DIRECTORY',
                       help='dashboard design package containing design.json, CSS and optional logo/fonts')

    selected, remaining = parser.parse_known_args(argv)
    command_parser = selected.argument_parser
    if command_parser is None:
        if remaining:
            parser.error(f'unrecognized arguments: {" ".join(remaining)}')
        parser.print_help()
        parser.exit()
    args = command_parser.parse_intermixed_args(remaining, namespace=selected)
    if not hasattr(args, 'root'):
        args.root = args.root_default() if args.root_default else None
    if args.validate:
        args.validate(command_parser, args)
    return args


def main(argv=None):
    args = arguments(sys.argv[1:] if argv is None else argv)
    try:
        args.handler(args)
        return 0
    except (KeyboardInterrupt, BrokenPipeError):
        return 0
    except (OSError, ValueError, LaunchError, subprocess.CalledProcessError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
