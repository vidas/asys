"""One local dashboard for saved and running systems in an explicit state root."""
import hashlib
import json
import mimetypes
import os
import stat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import parse_qs, unquote, urlsplit
import xml.etree.ElementTree as ET

from asys_runtime.channel import Writer, direction_root
from asys_runtime.files import validate_name
from asys_runtime.queue import Queue

from .runs import JOB_TERMINAL, TERMINAL, Runs, tail
from .state import state_root
from .transcript import EventOutput, JobOutput, fields, render, render_live, session_entries
from .world_history import WorldHistory
from .dashboard_design import Design, DEFAULT_DESIGN, asset as design_asset
from .dashboard_workflow import graph as workflow_graph

ASSETS = Path(__file__).with_name('dashboard_assets')
MEMBER_ATTEMPTS = 100
SWARM_ATTEMPTS = 32
TRANSCRIPT_CHARACTERS = 256 * 1024
TRANSCRIPT_SOURCES = 512
WORLD_ARTIFACT_BYTES = 32 * 1024 * 1024


def contained(root, relative):
    root = Path(root).resolve()
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError('Path must remain inside its saved directory')
    return candidate


def document(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return {} if default is None else default


def recent_events(path):
    result = []
    for line in tail(path, 100):
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                result.append(value)
        except ValueError:
            pass  # An append may still be in progress.
    return result


def transcript_text(lines):
    text = '\n'.join(lines)
    if len(text) > TRANSCRIPT_CHARACTERS:
        text = '[Earlier transcript text omitted from this view.]\n' + text[-TRANSCRIPT_CHARACTERS:]
    return text


def saved_document(root, relative):
    path = contained(root, relative)
    if path.exists() and path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('Saved evidence document exceeds the 8 MiB display limit')
    return document(path)


def bounded_records(records, label='output records'):
    selected, size = [], 0
    for record in reversed(records):
        length = (len(record['displayText'].encode()) if label == 'saved messages' and 'displayText' in record
                  else len(json.dumps(record, ensure_ascii=False).encode()))
        if size + length <= TRANSCRIPT_CHARACTERS:
            selected.append(record)
            size += length
    notice = (f'{len(records) - len(selected)} {label} exceed the display budget.'
              if len(selected) < len(records) else None)
    return list(reversed(selected)), notice


def source_identity(agent, metadata, fallback='Agent'):
    """Use recorded names; retain instance IDs when an authored agent is shared."""
    def name(value):
        return value.strip() if isinstance(value, str) and value.strip() else None
    agent_name = name(agent.get('name'))
    participant, member = name(metadata.get('participant')), name(metadata.get('member'))
    display = participant or agent_name or member or name(fallback) or 'Agent'
    if participant and agent_name and participant != agent_name:
        display = f'{participant} ({agent_name})'
    elif member and agent_name and member != agent_name:
        display = f'{agent_name} ({member})'
    parts = [display]
    for key in ('turn', 'round', 'attempt'):
        if metadata.get(key) is not None:
            parts.append(f'{key.capitalize()} {metadata[key]}')
    for key in ('phase', 'stage'):
        if name(metadata.get(key)):
            parts.append(metadata[key])
    return {'memberName': display, 'agentName': agent_name, 'title': ' · '.join(parts)}


def saved_messages(agent, relative, metadata, *, current_turn=False):
    names = source_identity(agent, metadata)
    session = agent.get('session', {})
    entries = session_entries(session)
    if current_turn:
        start = agent.get('sessionStartEntryCount', 0)
        if isinstance(start, int) and start > 0:
            previous = {entry.get('id') for entry in session.get('entries', [])[:start]}
            entries = [entry for entry in entries if entry.get('id') not in previous]
    source_id = hashlib.sha256(relative.encode()).hexdigest()
    messages = []
    for index, entry in enumerate(entries):
        if entry.get('type') == 'compaction':
            original = {'role': 'context', 'content': [{'type': 'text', 'text': entry.get('summary', '')}]}
        elif entry.get('type') == 'message' and isinstance(entry.get('message'), dict):
            original = entry['message']
        else:
            continue
        entry_id = str(entry.get('id', index))
        identity = hashlib.sha256(f'{relative}\0{entry_id}'.encode()).hexdigest()
        message = {**original, 'id': identity, 'sourceId': source_id, 'source': relative,
                   'displayText': '\n'.join(render({'session': {'entries': [entry]}}))}
        message.update(memberName=names['memberName'], agentName=names['agentName'])
        message.update({key: metadata[key] for key in ('member', 'turn', 'phase', 'stage', 'participant', 'attempt', 'round') if key in metadata})
        messages.append(message)
    return messages


class DashboardData:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.runs = Runs(state_root('runs', root=self.root))
        self.histories = {}
        self.transcripts = {}

    def run_directory(self, identity):
        # HTTP selectors never accept arbitrary filesystem paths or prefixes.
        if not identity or identity in {'.', '..'} or '/' in identity or '\\' in identity:
            raise ValueError('Expected a full run ID')
        path = contained(self.runs.root, identity)
        if not (path / 'run.json').is_file():
            raise FileNotFoundError('Run is unavailable in this state root')
        return path

    def decorate_job(self, job):
        job = dict(job)
        worker = document(Path(job['directory']) / 'worker.json')
        directory = Path(job['directory'])
        kind = worker.get('kind') or job.get('metadata', {}).get('worker_kind')
        if not kind:
            kind = next((name for name, path in (
                ('swarm', 'swarm/checkpoint.json'), ('goal', 'goal.json'),
                ('senate', 'senate.json'), ('agent', 'agent.json'))
                if (directory / path).is_file()), 'human' if job.get('type') == 'human' else 'program')
        job['kind'] = kind
        return job

    def overview(self):
        rows = []
        for directory in self.runs.directories():
            try:
                record = self.runs.snapshot(directory)
                jobs = record.pop('jobs')
                active = [job for job in jobs if job.get('status') not in JOB_TERMINAL]
                record['jobs'] = {'total': len(jobs), 'active': len(active)}
                record['kind'] = record.get('worker_kind') or ('workflow' if record.get('workflow') else 'program')
                record['activity'] = record.get('error') or next((j.get('detail') for j in reversed(active) if j.get('detail')), '')
                rows.append(record)
            except (OSError, ValueError, KeyError) as error:
                rows.append({'id': directory.name, 'name': directory.name, 'status': 'unavailable',
                             'error': str(error), 'jobs': {'total': 0, 'active': 0}})
        return {'scope': str(self.root), 'runs': rows}

    def run(self, identity):
        directory = self.run_directory(identity)
        record = self.runs.snapshot(directory)
        jobs = [self.decorate_job(job) for job in record.pop('jobs')]
        worker_kinds = {job['type']: job['kind'] for job in jobs if job.get('type')}
        worker_kinds.update(record.get('worker_kinds', {}))
        result = {'run': record, 'jobs': jobs, 'events': recent_events(directory / 'events.jsonl')}
        # This graph is presentation only. Status always comes from runtime jobs.
        workflow = directory / 'workflow/workflow.bpmn'
        if not workflow.is_file():
            workflow = directory / 'workflow.bpmn'
        if workflow.is_file():
            try:
                result['workflow'] = workflow_graph(workflow.read_bytes(), worker_kinds)
            except ET.ParseError as error:
                result['workflow'] = {'error': str(error), 'nodes': [], 'edges': []}
        return result

    def locate_job(self, identity, job_id):
        directory = self.run_directory(identity)
        record = self.runs.snapshot(directory)
        job = next((row for row in record['jobs'] if row['id'] == job_id), None)
        if job is None:
            raise FileNotFoundError('Job is unavailable in this run')
        contained(directory, job['directory'])
        return directory, record, self.decorate_job(job)

    def job(self, identity, job_id):
        _, record, job = self.locate_job(identity, job_id)
        directory = Path(job['directory'])
        members = None
        if job['kind'] == 'swarm':
            _, checkpoint, members, attempts = self.swarm_members(identity, job_id)
            title = 'Swarm'
            lines = [f"Mission: {checkpoint.get('config', {}).get('mission', '')}",
                     f"Status: {checkpoint.get('status', job.get('status', 'unknown'))} · Turn: {checkpoint.get('turn', 0)}",
                     f"Members: {len(members)} · Saved decisions: {len(attempts)}", '']
            if checkpoint.get('evaluation', {}).get('summary'):
                lines += [checkpoint['evaluation']['summary'], '']
            evidence = self.attempt_evidence(directory, attempts, SWARM_ATTEMPTS, status=job.get('status'))
            lines += evidence['conversation']
        else:
            reader = self.transcripts.setdefault((identity, job_id), JobOutput())
            title, lines = reader.read(job)
        data = {}
        for kind, relative in (('input', 'input.json'), ('goal', 'goal.json'), ('senate', 'senate.json'), ('agent', 'agent.json'),
                               ('swarm', 'swarm/checkpoint.json'), ('result', 'result.json')):
            path = directory / relative
            if path.is_file():
                data[kind] = document(path)
        data['logs'] = {stream: '\n'.join(tail(directory / f'{stream}.log', 200)) for stream in ('stdout', 'stderr')}
        worker = document(directory / 'worker.json')
        result = {'job': job, 'worker': worker, 'kind': job['kind'], 'data': data,
                  'control': self.capabilities(record, job, worker),
                  'transcript': {'title': title, 'text': transcript_text(lines)}}
        if members is not None:
            result['members'] = members
            result['hasConversation'] = evidence['hasConversation']
            result['output'] = {'title': 'Decision output', 'text': transcript_text(evidence['output']),
                                'records': evidence['records'], 'notice': evidence['notice']}
            result['transcript'].update(messages=evidence['messages'], messagesNotice=evidence['messagesNotice'])
        sources = self.source_index(job, attempts=attempts if members is not None else None)
        result['transcript'].update(sources=sources['sources'], sourcesNotice=sources['notice'])
        if members is None:
            messages, notices = [], []
            for source in sources['sources']:
                value = self.source_record(job, source['path'], source, include_text=True,
                                           current_turn=job['kind'] in {'goal', 'senate'})
                messages += value['transcript'].get('messages', [])
                if value['transcript'].get('messagesNotice'):
                    notices.append(f"{source['title']}: {value['transcript']['messagesNotice']}")
            messages += self.live_messages(job, reader, sources['sources'])
            result['transcript']['messages'], notice = bounded_records(messages, 'saved messages')
            if notice:
                notices.append(notice)
            result['transcript']['messagesNotice'] = ' '.join(notices) or None
        return result

    def live_messages(self, job, reader, sources):
        """Reuse the terminal reader's validated stream and saved-parent check."""
        if not reader.live or not reader.live['blocks']:
            return []
        directory, relative = Path(job['directory']), 'agent.json'
        if job['kind'] in {'goal', 'senate'}:
            sessions = reader.files.read(directory / f"{job['kind']}.json").get('sessions', [])
            if not sessions or not sessions[-1].get('directory'):
                return []
            relative = (Path(sessions[-1]['directory']) / 'agent.json').as_posix()
        source = next((item for item in sources if item['path'] == relative), None)
        if source is None:
            return []
        agent = reader.files.read(contained(directory, relative)).get('agent')
        if not isinstance(agent, dict) or reader.live['parentId'] != agent.get('session', {}).get('leafId'):
            return []
        content = [{'type': kind, 'text' if kind == 'text' else 'thinking': ''.join(chunks)}
                   for _, (kind, chunks) in sorted(reader.live['blocks'].items())]
        session = {'entries': [{'type': 'message', 'id': f"live-{reader.live['parentId']}",
                               'message': {'role': 'assistant', 'content': content, 'live': True}}]}
        return saved_messages({**agent, 'session': session}, relative, source)

    def source_candidates(self, job, *, attempts=None, member=None):
        """Enumerate only the agent.json locations defined by saved worker records."""
        directory = Path(job['directory'])
        candidates = []

        def add(scope, path, metadata):
            path = contained(scope, path.relative_to(scope))
            contained(directory, path)
            if path.is_file():
                relative = path.relative_to(directory).as_posix()
                candidates.append((relative, metadata))

        if job['kind'] == 'swarm':
            for attempt in attempts or []:
                if member is not None and attempt['agent'] != member:
                    continue
                scope = contained(directory, f"swarm/decisions/{attempt['id']}")
                metadata = {'member': attempt['agent'], 'turn': attempt['turn'],
                            'status': attempt.get('status', 'unknown')}
                for path in [scope / 'agent.json', *sorted(scope.glob('*/agent.json'))]:
                    add(scope, path, {**metadata, **({'stage': path.parent.name} if path.parent != scope else {})})
        else:
            add(directory, directory / 'agent.json', {'status': job.get('status', 'unknown')})
            if job['kind'] in {'goal', 'senate'}:
                checkpoint = saved_document(directory, f"{job['kind']}.json")
                for session in checkpoint.get('sessions', []):
                    relative = session.get('directory')
                    if not isinstance(relative, str) or not relative:
                        continue
                    if Path(relative).is_absolute() or '..' in Path(relative).parts:
                        raise ValueError('Saved session directory must stay inside its job')
                    scope = contained(directory, relative)
                    metadata = {key: session[key] for key in ('participant', 'phase', 'attempt', 'round', 'status') if key in session}
                    add(scope, scope / 'agent.json', metadata)
        return list({path: (path, metadata) for path, metadata in candidates}.values())

    def source_record(self, job, relative, metadata, *, include_text=False, current_turn=False, complete=False):
        row = {'id': hashlib.sha256(relative.encode()).hexdigest(), 'path': relative,
               **metadata, **source_identity({}, metadata, job.get('name')), 'hasConversation': False}
        try:
            value = saved_document(Path(job['directory']), relative)
            agent = value.get('agent')
            if not isinstance(agent, dict) or not isinstance(agent.get('session'), dict):
                raise ValueError('Saved agent.json does not contain an agent session object')
            row.update(source_identity(agent, metadata, job.get('name')))
            entries = agent['session'].get('entries', [])
            if not isinstance(entries, list) or any(not isinstance(entry, dict) for entry in entries):
                raise ValueError('Saved agent session entries must be an array of objects')
            row['model'] = agent.get('model')
            row['hasConversation'] = any(entry.get('type') == 'message' for entry in session_entries(agent['session']))
            row['status'] = agent.get('status', row.get('status', 'unknown'))
            if not row['hasConversation']:
                row['status'] = 'pending' if row['status'] not in JOB_TERMINAL else 'empty'
            if include_text:
                lines = (render(agent) if row['hasConversation'] else
                         ['Waiting for saved agent messages…'] if row['status'] == 'pending' else
                         ['This saved agent.json has no message entries.'])
                row['transcript'] = {'title': row['title'], 'text': '\n'.join(lines) if complete else transcript_text(lines)}
                messages = saved_messages(agent, relative, metadata, current_turn=current_turn)
                messages, notice = (messages, None) if complete else bounded_records(messages, 'saved messages')
                row['transcript'].update(messages=messages, messagesNotice=notice)
        except (OSError, ValueError, TypeError, AttributeError) as error:
            row.update(status='error', error=f'{relative}: {error}')
            if include_text:
                row['transcript'] = {'title': row['title'], 'text': row['error'], 'messages': [], 'messagesNotice': None}
        return row

    def source_index(self, job, *, attempts=None, member=None):
        candidates = self.source_candidates(job, attempts=attempts, member=member)
        return {'sources': [self.source_record(job, path, metadata) for path, metadata in candidates[-TRANSCRIPT_SOURCES:]],
                'notice': (f'Showing the latest {TRANSCRIPT_SOURCES} of {len(candidates)} saved agent.json sources.'
                           if len(candidates) > TRANSCRIPT_SOURCES else None)}

    def sources(self, identity, job_id):
        _, _, job = self.locate_job(identity, job_id)
        attempts = self.swarm_members(identity, job_id)[3] if job['kind'] == 'swarm' else None
        return self.source_index(job, attempts=attempts)

    def source(self, identity, job_id, source_id):
        if len(source_id) != 64 or any(character not in '0123456789abcdef' for character in source_id):
            raise ValueError('Expected a saved transcript source ID')
        _, _, job = self.locate_job(identity, job_id)
        attempts = self.swarm_members(identity, job_id)[3] if job['kind'] == 'swarm' else None
        for path, metadata in self.source_candidates(job, attempts=attempts):
            if hashlib.sha256(path.encode()).hexdigest() == source_id:
                source = self.source_record(job, path, metadata, include_text=True, complete=True)
                if job['kind'] != 'swarm' and not source.get('error'):
                    reader = self.transcripts.setdefault((identity, job_id), JobOutput())
                    reader.read(job)
                    live = self.live_messages(job, reader, [source])
                    if live:
                        transcript = source['transcript']
                        transcript['messages'] += live
                        transcript['text'] = '\n'.join(
                            ([transcript['text']] if source['hasConversation'] else []) + render_live(reader.live))
                        source['hasConversation'] = True
                return source
        raise FileNotFoundError('Transcript source is unavailable in this job')

    def swarm_members(self, identity, job_id):
        """Index saved local attempts, never treat them as runtime jobs."""
        _, _, job = self.locate_job(identity, job_id)
        if job['kind'] != 'swarm':
            raise ValueError('This job does not contain swarm members')
        directory = Path(job['directory'])
        checkpoint = saved_document(directory, 'swarm/checkpoint.json')
        members = {}
        for member in checkpoint.get('agents', []):
            validate_name('member ID', member)
            members[member] = {'id': member, 'name': member, 'status': 'waiting', 'turn': None, 'decisions': 0}
        attempts = []
        root = contained(directory, 'swarm/decisions')
        for path in sorted(root.glob('*/state.json')):
            attempt_directory = contained(root, path.parent.name)
            state = saved_document(attempt_directory, 'state.json')
            member, turn = state.get('agent'), state.get('turn')
            if not isinstance(member, str) or type(turn) is not int or turn < 0:
                continue
            validate_name('member ID', member)
            validate_name('decision ID', path.parent.name)
            if state.get('id') != path.parent.name:
                continue
            attempts.append({key: state[key] for key in ('id', 'agent', 'turn', 'status',
                'submitted_at', 'started_at', 'finished_at', 'error') if key in state})
        attempts.sort(key=lambda row: (row['turn'], row.get('submitted_at', ''), row['id']))
        for state in attempts:
            member = state['agent']
            row = members.setdefault(member, {'id': member, 'name': member, 'decisions': 0})
            row.update(status=state.get('status', 'unknown'), turn=state['turn'], latestDecision=state['id'])
            row['decisions'] += 1
        pending = checkpoint.get('pending') or {}
        for member, decision in pending.get('decisions', {}).items():
            if member in members and decision.get('status') == 'planned':
                members[member].update(status='planned', turn=pending.get('turn'))
        return job, checkpoint, list(members.values()), attempts

    def members(self, identity, job_id):
        _, _, members, _ = self.swarm_members(identity, job_id)
        return {'members': members}

    def member(self, identity, job_id, member_id):
        validate_name('member ID', member_id)
        job, _, members, attempts = self.swarm_members(identity, job_id)
        member = next((item for item in members if item['id'] == member_id), None)
        if member is None:
            raise FileNotFoundError('Member is unavailable in this swarm job')
        selected = [item for item in attempts if item['agent'] == member_id]
        evidence = self.attempt_evidence(Path(job['directory']), selected, MEMBER_ATTEMPTS, status=job.get('status'))
        sources = self.source_index(job, attempts=selected, member=member_id)
        return {**member, 'hasConversation': evidence['hasConversation'],
                'transcript': {'title': f'Member {member_id}', 'text': transcript_text(evidence['conversation']),
                               'sources': sources['sources'], 'sourcesNotice': sources['notice'],
                               'messages': evidence['messages'], 'messagesNotice': evidence['messagesNotice']},
                'output': {'title': 'Decision output', 'text': transcript_text(evidence['output']),
                           'records': evidence['records'], 'notice': evidence['notice']},
                'data': {'attempts': selected[-MEMBER_ATTEMPTS:], 'totalAttempts': len(selected),
                         'shownAttempts': min(len(selected), MEMBER_ATTEMPTS)}}

    def attempt_evidence(self, directory, attempts, limit, *, status=None):
        conversation, lines, records, messages = [], [], [], []
        has_conversation = False
        if not attempts:
            message = ('Waiting for saved agent messages…' if status not in JOB_TERMINAL
                       else 'No saved agent session is available for the decisions shown. Process diagnostics are in Output.')
            return {'conversation': [message],
                    'output': ['No member decision evidence has been saved yet.'], 'hasConversation': False,
                    'records': [], 'notice': None, 'messages': [], 'messagesNotice': None}
        if len(attempts) > limit:
            lines += [f'Showing the latest {limit} of {len(attempts)} saved decisions.', '']
            conversation += lines
        for state in attempts[-limit:]:
            path = contained(directory, f"swarm/decisions/{state['id']}")
            heading = [f"{state['agent']} · Turn {state['turn']} · Decision {state['id']} ({state.get('status', 'unknown')})", '']
            lines += heading
            sessions = [path / 'agent.json', *sorted(path.glob('*/agent.json'))]
            found = False
            for session_path in sessions:
                session = saved_document(path, session_path.relative_to(path))
                agent = session.get('agent')
                if (isinstance(agent, dict) and isinstance(agent.get('session'), dict)
                        and any(entry.get('type') == 'message' for entry in agent['session'].get('entries', []))):
                    if not found:
                        conversation += heading
                    found = True
                    has_conversation = True
                    if session_path.parent != path:
                        conversation += [f'Stage: {session_path.parent.name}', '']
                    conversation += [f'Source: {session_path.relative_to(directory).as_posix()}', '']
                    if agent.get('model'):
                        conversation += [f"Model: {agent['model']}", '']
                    conversation += render(agent, current_turn=True)
                    messages += saved_messages(agent, session_path.relative_to(directory).as_posix(),
                        {'member': state['agent'], 'turn': state['turn'],
                         **({'stage': session_path.parent.name} if session_path.parent != path else {})}, current_turn=True)
            if not found:
                message = ('Waiting for saved agent messages…' if state.get('status') not in JOB_TERMINAL
                           else 'No saved agent session is available for this decision. Process diagnostics are in Output.')
                conversation += heading + [message, '']
                input_value = saved_document(path, 'input.json')
                if input_value:
                    lines += ['Decision input', *fields(input_value), '']
                    records.append({'id': f"{state['id']}-input", 'title': f"{state['agent']} · Turn {state['turn']} · Decision input",
                                    'type': 'input', 'data': input_value})
            result = saved_document(path, 'result.json')
            if result:
                lines += ['Decision result', *fields(result), '']
                records.append({'id': f"{state['id']}-result", 'title': f"{state['agent']} · Turn {state['turn']} · Decision result",
                                'type': 'result', 'data': result})
            output = EventOutput()
            for line in tail(contained(path, 'stdout.log'), 200):
                output.append(line)
            if output.read():
                lines += ['Recent process output', *output.read(), '']
                records.append({'id': f"{state['id']}-stdout", 'title': f"{state['agent']} · Turn {state['turn']} · Process output",
                                'type': 'log', 'stream': 'stdout', 'text': '\n'.join(output.read())})
            if state.get('error'):
                lines += ['Error', str(state['error']), '']
            errors = tail(contained(path, 'stderr.log'), 100)
            lines += [f'stderr: {line}' for line in errors]
            if errors:
                records.append({'id': f"{state['id']}-stderr", 'title': f"{state['agent']} · Turn {state['turn']} · Diagnostics",
                                'type': 'log', 'stream': 'stderr', 'text': '\n'.join(errors)})
            if sum(len(line) + 1 for line in lines) > TRANSCRIPT_CHARACTERS:
                lines = [transcript_text(lines)]
            if sum(len(line) + 1 for line in conversation) > TRANSCRIPT_CHARACTERS:
                conversation = [transcript_text(conversation)]
        if not has_conversation:
            message = ('Waiting for saved agent messages…' if any(state.get('status') not in JOB_TERMINAL
                for state in attempts[-limit:]) else
                'No saved agent session is available for the decisions shown. Process diagnostics are in Output.')
            conversation = [message]
        records, notice = bounded_records(records)
        messages, messages_notice = bounded_records(messages, 'saved messages')
        return {'conversation': conversation, 'output': lines, 'hasConversation': has_conversation,
                'records': records, 'notice': notice, 'messages': messages, 'messagesNotice': messages_notice}

    def history(self, identity, job_id):
        _, _, job = self.locate_job(identity, job_id)
        if job['kind'] != 'swarm':
            raise ValueError('This job does not publish a world')
        return self.histories.setdefault((identity, job_id), WorldHistory(job['directory']))

    def view(self, identity, job_id):
        directory, record, job = self.locate_job(identity, job_id)
        worker = saved_document(Path(job['directory']), 'worker.json')
        generation = worker.get('world_view')
        if generation is not None:
            saved = record.get('world_view_versions', {}).get(generation)
            if not saved:
                raise ValueError('This job\'s saved world viewer generation is unavailable')
        else:
            # Preserve observation of jobs saved before per-job view bindings.
            saved = record.get('world_views', {}).get(job.get('type'), {})
        if not saved:
            return None, None
        root = contained(directory, saved['directory'])
        entry = contained(root, saved['entry'])
        if entry.suffix not in {'.js', '.mjs'} or not entry.is_file():
            raise ValueError('World viewer must be a saved JavaScript module')
        return root, entry

    def world_artifact(self, identity, job_id, reference):
        """Read immutable text evidence from this job's recorded world runtime."""
        if not isinstance(reference, dict) or set(reference) != {'path', 'sha256', 'size'}:
            raise ValueError('Expected a world artifact path, sha256 and size')
        path, digest, size = (reference[key] for key in ('path', 'sha256', 'size'))
        if (not isinstance(path, str) or not path or len(path) > 4096 or '\\' in path or '\0' in path
                or any(part in {'', '.', '..'} for part in path.split('/'))):
            raise ValueError('World artifact path must be a contained relative path')
        if (not isinstance(digest, str) or len(digest) != 64
                or any(character not in '0123456789abcdef' for character in digest)):
            raise ValueError('World artifact sha256 must be a lowercase SHA-256 digest')
        if type(size) is not int or not 0 <= size <= WORLD_ARTIFACT_BYTES:
            raise ValueError('World artifact size must be an integer from 0 to 32 MiB')
        directory, record, job = self.locate_job(identity, job_id)
        if job['kind'] != 'swarm':
            raise ValueError('This job does not publish world artifacts')
        worker = saved_document(Path(job['directory']), 'worker.json')
        package = worker.get('world_package')
        binding = record.get('world_components', {}).get(package) if isinstance(package, str) else None
        if not isinstance(binding, dict):
            raise FileNotFoundError("This job's recorded world runtime is unavailable")
        runtime = binding.get('runtime')
        if (not isinstance(runtime, str) or '\0' in runtime or '\\' in runtime
                or len(runtime.split('/')) != 2 or runtime.split('/')[0] != 'worlds'
                or runtime.split('/')[1] in {'', '.', '..'}):
            raise ValueError('Recorded world runtime must be worlds/<binding-id>')
        # Walk open directory descriptors so a symlink or concurrent directory
        # replacement cannot redirect this read outside the recorded runtime.
        descriptors = []
        try:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            descriptors.append(os.open(directory, flags))
            parts = ['runtime', *runtime.split('/'), *path.split('/')]
            for part in parts[:-1]:
                descriptors.append(os.open(part, flags, dir_fd=descriptors[-1]))
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                 dir_fd=descriptors[-1])
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('World artifact must be a regular file')
            if info.st_size != size:
                raise ValueError('World artifact size does not match its reference')
            with os.fdopen(os.dup(descriptor), 'rb') as stream:
                contents = stream.read(size + 1)
            if len(contents) != size or hashlib.sha256(contents).hexdigest() != digest:
                raise ValueError('World artifact content does not match its reference')
            contents.decode('utf-8')
            return contents
        except FileNotFoundError:
            raise FileNotFoundError('World artifact is unavailable') from None
        except OSError:
            raise ValueError('World artifact path must contain only directories and a regular file, without symlinks') from None
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    def capabilities(self, record, job, worker):
        active = record.get('status') not in TERMINAL and job.get('status') not in JOB_TERMINAL
        state = document(Path(job['directory']) / 'swarm/checkpoint.json') if job['kind'] == 'swarm' else {}
        swarm = active and bool(worker.get('control_channel')) and state.get('status') not in TERMINAL
        return {'pause': bool(swarm and state.get('status') != 'paused'),
                'resume': bool(swarm and state.get('status') == 'paused'), 'cancel': bool(active)}

    def world(self, identity, job_id):
        _, record, job = self.locate_job(identity, job_id)
        history = self.history(identity, job_id)
        root, entry = self.view(identity, job_id)
        frames = [{**frame, 'index': frame['sequence']} for frame in history.frames()]
        with history._lock:
            history._scan_journal()
            sequences = list(history._index)[-100:]
            events = []
            for sequence in sequences:
                event = history._journal_event(sequence)
                if event.get('type') == 'swarm.snapshot':
                    event['data'] = {key: value for key, value in event['data'].items() if key != 'state'}
                events.append(event)
        return {'snapshot': history.state(), 'frames': frames, 'events': events,
                'view': {'module': f'/api/runs/{identity}/jobs/{job_id}/view/{entry.relative_to(root).as_posix()}' if entry else None},
                'control': self.capabilities(record, job, document(Path(job['directory']) / 'worker.json'))}

    def control(self, identity, job_id, action):
        directory, record, job = self.locate_job(identity, job_id)
        worker = document(Path(job['directory']) / 'worker.json')
        if not self.capabilities(record, job, worker).get(action):
            raise ValueError('This execution control is unavailable for the current job state')
        if job['kind'] == 'swarm' and worker.get('control_channel'):
            return Writer(direction_root(directory / 'runtime', worker['control_channel'], 'in')).send(action, {'id': job_id})
        if action != 'cancel':
            raise ValueError('Only swarm jobs support pause and resume')
        return Queue(contained(directory / 'runtime/environments', job['environment'])).cancel(job_id)


class Dashboard:
    def __init__(self, root, *, port=0, design=None):
        self.data = DashboardData(root)
        self.design = Design(design)
        self.lock = threading.RLock()
        dashboard = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def respond(self, code, body, mime='application/json; charset=utf-8'):
                if not isinstance(body, bytes):
                    body = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
                self.send_response(code)
                for key, value in {'Content-Type': mime, 'Content-Length': str(len(body)),
                    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'"}.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def file(self, path):
                if not path.is_file():
                    raise FileNotFoundError('Asset not found')
                mime = 'text/javascript' if path.suffix in {'.js', '.mjs'} else mimetypes.guess_type(path)[0]
                self.respond(200, path.read_bytes(), mime or 'application/octet-stream')

            def allowed(self):
                return self.headers.get('Host') in dashboard.hosts

            def do_GET(self):
                if not self.allowed():
                    return self.respond(403, {'error': 'Local dashboard host required'})
                path = unquote(urlsplit(self.path).path)
                try:
                    with dashboard.lock:
                        data = dashboard.data
                        if path == '/':
                            return self.respond(200, dashboard.design.html((ASSETS / 'index.html').read_text()), 'text/html; charset=utf-8')
                        if path.startswith('/design/default/'):
                            return self.file(design_asset(DEFAULT_DESIGN, path[len('/design/default/'):]))
                        if path.startswith('/design/custom/'):
                            return self.file(design_asset(dashboard.design.root, path[len('/design/custom/'):]))
                        if path.startswith('/assets/'):
                            return self.file(contained(ASSETS, path[len('/assets/'):]))
                        parts = path.strip('/').split('/')
                        if parts == ['api', 'runs']:
                            return self.respond(200, data.overview())
                        if parts[:2] != ['api', 'runs'] or len(parts) < 3:
                            raise FileNotFoundError('Unknown endpoint')
                        identity = parts[2]
                        if len(parts) == 3:
                            return self.respond(200, data.run(identity))
                        if len(parts) < 5 or parts[3] != 'jobs':
                            raise FileNotFoundError('Unknown endpoint')
                        job = parts[4]
                        if len(parts) == 5:
                            return self.respond(200, data.job(identity, job))
                        if parts[5:] == ['world']:
                            return self.respond(200, data.world(identity, job))
                        if parts[5:] == ['world-artifact']:
                            query = parse_qs(urlsplit(self.path).query, keep_blank_values=True, strict_parsing=True)
                            if set(query) != {'path', 'sha256', 'size'} or any(len(value) != 1 for value in query.values()):
                                raise ValueError('Expected one world artifact path, sha256 and size')
                            reference = {key: value[0] for key, value in query.items()}
                            reference['size'] = int(reference['size'])
                            contents = data.world_artifact(identity, job, reference)
                            return self.respond(200, contents, 'text/plain; charset=utf-8')
                        if parts[5:] == ['members']:
                            return self.respond(200, data.members(identity, job))
                        if len(parts) == 7 and parts[5] == 'members':
                            return self.respond(200, data.member(identity, job, parts[6]))
                        if parts[5:] == ['transcripts']:
                            return self.respond(200, data.sources(identity, job))
                        if len(parts) == 7 and parts[5] == 'transcripts':
                            return self.respond(200, data.source(identity, job, parts[6]))
                        if len(parts) == 7 and parts[5] == 'frames':
                            return self.respond(200, data.history(identity, job).state(int(parts[6])))
                        if len(parts) >= 7 and parts[5] == 'view':
                            root, _ = data.view(identity, job)
                            if root is None:
                                raise FileNotFoundError('This world has no viewer')
                            return self.file(contained(root, '/'.join(parts[6:])))
                        raise FileNotFoundError('Unknown endpoint')
                except FileNotFoundError as error:
                    self.respond(404, {'error': str(error)})
                except (OSError, ValueError, KeyError, TypeError) as error:
                    self.respond(400, {'error': str(error)})

            def do_POST(self):
                if not self.allowed():
                    return self.respond(403, {'error': 'Local dashboard host required'})
                origin = self.headers.get('Origin')
                if (origin is not None and origin != f"http://{self.headers.get('Host')}"
                        or self.headers.get('Sec-Fetch-Site') not in {None, 'same-origin', 'none'}):
                    return self.respond(403, {'error': 'Same-origin execution control required'})
                if self.headers.get_content_type() != 'application/json':
                    return self.respond(415, {'error': 'Use application/json'})
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 1 <= length <= 4096:
                        raise ValueError('Expected a JSON control object of at most 4096 bytes')
                    value = json.loads(self.rfile.read(length))
                    if not isinstance(value, dict) or set(value) != {'action'}:
                        raise ValueError('Expected an action')
                    parts = unquote(urlsplit(self.path).path).strip('/').split('/')
                    if len(parts) != 6 or parts[:2] != ['api', 'runs'] or parts[3] != 'jobs' or parts[5] != 'control':
                        raise FileNotFoundError('Unknown endpoint')
                    with dashboard.lock:
                        result = dashboard.data.control(parts[2], parts[4], value['action'])
                    self.respond(202, result)
                except FileNotFoundError as error:
                    self.respond(404, {'error': str(error)})
                except (OSError, ValueError, KeyError, TypeError) as error:
                    self.respond(400, {'error': str(error)})

        self.server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.hosts = {f'127.0.0.1:{self.port}', f'localhost:{self.port}'}
        self.url = f'http://127.0.0.1:{self.port}/'
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def close(self):
        if self.thread:
            self.server.shutdown()
            self.thread.join(timeout=5)
        self.server.server_close()


def dashboard(args):
    viewer = Dashboard(args.root, port=args.port, design=args.design).start()
    print(f'Dashboard: {viewer.url}\nState: {viewer.data.root}\nPress Ctrl-C to close the dashboard.', flush=True)
    try:
        viewer.thread.join()
    finally:
        viewer.close()
