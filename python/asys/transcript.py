"""Render the saved agent conversation and its currently streaming response."""
from collections import deque
import json
from pathlib import Path
import textwrap

from .runs import Files, JOB_TERMINAL, LogReader, tail


def fields(value, indent=""):
    """Display report fields without JSON quoting or escaped newlines."""
    if isinstance(value, dict) and value:
        lines = []
        for key, item in value.items():
            label = key.replace("_", " ").capitalize()
            content = fields(item, indent + "  ")
            lines += [f"{indent}{label}:", *content]
        return lines
    if isinstance(value, list) and value:
        lines = []
        for item in value:
            content = fields(item, indent + "  ")
            lines += [indent + "- " + content[0][len(indent) + 2:], *content[1:]]
        return lines
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return [indent + line for line in text.splitlines()] or [indent]


def agent_report(text):
    try:
        report = json.loads(text)
    except (ValueError, TypeError):
        return None
    if (isinstance(report, dict) and isinstance(report.get("final"), str) and report["final"].strip()
            and "exception" in report and (report["exception"] is None
                or isinstance(report["exception"], str) and report["exception"].strip())):
        return report
    return None


def message_lines(label, text):
    report = agent_report(text) if label == "Assistant" else None
    if report is not None:
        details = {key: value for key, value in report.items() if key != "final"}
        return [label, *report["final"].splitlines(), "", *fields(details), ""]
    return [label, *str(text).splitlines(), ""]


class EventOutput:
    """Readable recent events when a worker transcript is not available yet."""
    def __init__(self):
        self.lines = deque(maxlen=100)
        self.blocks = {}
        self.session = None

    def live_lines(self):
        return render_live({"blocks": self.blocks}) if self.blocks else []

    def flush(self):
        self.lines.extend(self.live_lines())
        self.blocks.clear()
        self.session = None

    def read(self):
        return list(self.lines) + self.live_lines()

    def append(self, line):
        try:
            event = json.loads(line)
        except ValueError:
            event = None
        kind = event.get("type") if isinstance(event, dict) else None
        if not isinstance(kind, str):
            kind = None
        if kind == "agent.message_delta":
            block_kind, index, delta = event.get("kind"), event.get("contentIndex"), event.get("delta")
            if (isinstance(block_kind, str) and block_kind in {"text", "thinking"}
                    and type(index) is int and index >= 0 and isinstance(delta, str)):
                if event.get("session") != self.session:
                    self.flush()
                    self.session = event.get("session")
                block = self.blocks.setdefault(index, (block_kind, []))
                if block[0] == block_kind:
                    block[1].append(delta)
                    return
            # Invalid or future event payloads remain visible as ordinary output.
        self.flush()
        if kind == "agent.message_started":
            return
        if kind in {"goal.phase_started", "goal.phase_finished"}:
            state = "started" if kind.endswith("started") else event.get("status", "finished")
            self.lines.extend([f"Attempt {event.get('attempt', '?')}: {event.get('phase', '?')} ({state})", ""])
        elif kind in {"senate.phase_started", "senate.phase_finished"}:
            state = "started" if kind.endswith("started") else event.get("status", "finished")
            self.lines.extend([f"Round {event.get('round', '?')}: {event.get('participant', '?')} "
                               f"{event.get('phase', '?')} ({state})", ""])
        elif kind in {"agent.tool_started", "agent.tool_completed"}:
            state = "started" if kind.endswith("started") else "failed" if event.get("isError") else "completed"
            self.lines.extend([f"Tool {state}: {event.get('name', 'tool')}", ""])
        elif kind in {"goal.human_requested", "goal.human_answered", "goal.finished", "senate.finished",
                      "agent.provider_exhausted", "agent.provider_retrying", "agent.model_unavailable",
                      "agent.compaction_started", "agent.compaction_ended", "agent.result_correcting"}:
            self.lines.extend([kind.replace(".", " ").replace("_", " ").capitalize(),
                               *fields({key: value for key, value in event.items()
                                        if key not in {"type", "time", "session"}}), ""])
        else:
            self.lines.append(f"stdout: {line}")


def session_entries(session):
    entries = session.get("entries", [])
    leaf = session.get("leafId")
    if not leaf:
        return entries
    by_id = {entry.get("id"): entry for entry in entries}
    branch, seen = [], set()
    while leaf in by_id and leaf not in seen:
        seen.add(leaf)
        entry = by_id[leaf]
        branch.append(entry)
        leaf = entry.get("parentId")
    return list(reversed(branch))


def render(agent, *, current_turn=False):
    lines = []

    def add(label, text):
        lines.extend(message_lines(label, text))

    session = agent.get("session", {})
    entries = session_entries(session)
    if current_turn:
        start = agent.get("sessionStartEntryCount", 0)
        if isinstance(start, int) and start > 0:
            previous = {entry.get("id") for entry in session.get("entries", [])[:start]}
            entries = [entry for entry in entries if entry.get("id") not in previous]
    for entry in entries:
        if entry.get("type") == "compaction":
            add("Context compacted", entry.get("summary", ""))
            continue
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        role = message.get("role", "message")
        label = {"user": "User", "assistant": "Assistant", "system": "System"}.get(role, role)
        if role == "toolResult":
            label = f"Tool result: {message.get('toolName', 'tool')}{' (error)' if message.get('isError') else ''}"
        content = message.get("content", [])
        if isinstance(content, str):
            add(label, content)
            continue
        text = "".join(block.get("text", "") for block in content if block.get("type") == "text")
        report = text if role == "assistant" and agent_report(text) is not None else None
        report_added = False
        for block in content:
            kind = block.get("type")
            if kind == "text":
                if report is None:
                    add(label, block.get("text", ""))
                elif not report_added:
                    add(label, report)
                    report_added = True
            elif kind == "thinking" and block.get("thinking"):
                add("Thinking", block["thinking"])
            elif kind == "toolCall":
                arguments = block.get("arguments", {})
                if isinstance(arguments, dict):
                    text = "\n".join(f"{key}: {value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)}"
                                     for key, value in arguments.items())
                else:
                    text = json.dumps(arguments, ensure_ascii=False)
                add(f"Tool call: {block.get('name', 'tool')}", text)
            elif kind == "image":
                add(label, f"[Image: {block.get('mimeType', 'image')}]")
        if message.get("errorMessage"):
            add("Error", message["errorMessage"])
    if not lines:
        if agent.get("prompt"):
            add("User", agent["prompt"])
        lines.append("Waiting for the agent's next saved message.")
    return lines


def wrap(lines, width):
    result = []
    for line in lines:
        # Never let saved output send terminal control characters to curses.
        line = "".join(c if c.isprintable() else " " for c in line.expandtabs(4))
        result.extend(textwrap.wrap(line, width=max(1, width), replace_whitespace=False,
                                    drop_whitespace=False, break_on_hyphens=False) or [""])
    return result


def render_live(live):
    content = [{"type": kind, "text" if kind == "text" else "thinking": "".join(chunks)}
               for _, (kind, chunks) in sorted(live["blocks"].items())]
    return render({"session": {"entries": [{"type": "message", "message": {
        "role": "assistant", "content": content}}]}})


class JobOutput:
    def __init__(self):
        self.key = None
        self.saved = None
        self.lines = []
        self.files = Files()
        self.reader = None
        self.live = None
        self.events = EventOutput()
        self.phase_outputs = {}

    def read(self, job):
        directory = Path(job["directory"])
        key = directory
        if self.key != key:
            self.key, self.saved, self.files = key, None, Files()
            self.reader, self.live = LogReader(directory / "stdout.log", None), None
            self.events, self.phase_outputs = EventOutput(), {}
        self.read_stream(flush=job.get("status") in JOB_TERMINAL)
        document = self.files.read(directory / "agent.json")
        agent = document.get("agent")
        errors = [f"stderr: {line}" for line in tail(directory / "stderr.log", 100)]
        goal = self.files.read(directory / 'goal.json')
        if goal.get('version') in (1, 2, 3, 4) and isinstance(goal.get('sessions'), list):
            return 'Goal', self.read_goal(directory, goal) + errors
        senate = self.files.read(directory / 'senate.json')
        if senate.get('version') == 1 and isinstance(senate.get('sessions'), list):
            lines = [f"Topic: {senate.get('topic', '')}", f"Status: {senate.get('status', '')}", '']
            return 'Senate', lines + self.read_phases(directory, senate['sessions'], senate=True) + errors
        swarm = self.files.read(directory / 'swarm/checkpoint.json')
        if swarm.get('version') in (1, 2) and isinstance(swarm.get('agents'), list):
            return 'Swarm', self.read_swarm(directory, swarm) + errors
        if isinstance(agent, dict):
            if self.saved is not document:
                self.saved, self.lines = document, render(agent)
            live = []
            if self.live and self.live["parentId"] == agent.get("session", {}).get("leafId"):
                live = render_live(self.live) if self.live['blocks'] else []
            return "Transcript", self.lines + live + errors
        return "Logs", self.events.read() + errors

    def read_goal(self, directory, goal):
        lines = [f"Goal: {goal.get('goal', '')}", f"Status: {goal.get('status', '')}", '']
        return lines + self.read_phases(directory, goal['sessions'])

    def read_swarm(self, directory, swarm):
        lines = [f"Mission: {swarm.get('config', {}).get('mission', '')}",
                 f"Status: {swarm.get('status', '')} · Turn: {swarm.get('turn', 0)} · "
                 f"Members: {len(swarm['agents'])} · Decisions: {swarm.get('decisions', 0)}", '']
        if swarm.get('evaluation', {}).get('summary'):
            lines += [swarm['evaluation']['summary'], '']
        attempts = []
        for path in (directory / 'swarm/decisions').glob('*/state.json'):
            if not path.resolve().is_relative_to(directory.resolve()):
                continue
            state = self.files.read(path)
            if isinstance(state.get('agent'), str) and type(state.get('turn')) is int:
                attempts.append((state, path.parent))
        attempts.sort(key=lambda row: (row[0]['turn'], row[0].get('submitted_at', ''), row[0].get('id', '')))
        # Keep the interactive display bounded. Full decisions remain in job
        # storage; one runtime job may contain thousands of member executions.
        recent = {}
        for state, path in attempts:
            recent[state['agent']] = (state, path)
        selected = sorted(recent.values(), key=lambda row: (row[0]['turn'], row[0].get('submitted_at', '')))[-16:]
        if len(recent) > len(selected):
            lines += [f'Showing the latest {len(selected)} of {len(recent)} active member histories.', '']
        for state, path in selected:
            lines += [f"{state['agent']} · Turn {state['turn']} ({state.get('status', 'unknown')})", '']
            # A trusted member program may use several bounded inference stages.
            transcripts = [path / 'agent.json', *sorted(path.glob('*/agent.json'))]
            found = False
            for transcript in transcripts:
                if not transcript.resolve().is_relative_to(path.resolve()):
                    continue
                agent = self.files.read(transcript).get('agent')
                if isinstance(agent, dict):
                    found = True
                    if transcript.parent != path:
                        lines += [transcript.parent.name, '']
                    lines += render(agent, current_turn=True)
            if not found:
                reader, output = self.phase_outputs.setdefault(path, (LogReader(path / 'stdout.log', None), EventOutput()))
                for line in reader.read(flush=state.get('status') in JOB_TERMINAL):
                    output.append(line)
                lines += output.read()
            if state.get('error'):
                lines += [str(state['error']), '']
            lines += [f'stderr: {line}' for line in tail(path / 'stderr.log', 20)]
        return lines

    def read_phases(self, directory, sessions, *, senate=False):
        lines = []
        current = None
        for session in sessions:
            relative = session.get('directory', '')
            path = (directory / relative).resolve()
            if not relative or not path.is_relative_to(directory.resolve()):
                continue
            heading = (f"Round {session['round']}: {session['participant']}" if senate
                       else f"Attempt {session['attempt']}:")
            lines += [f"{heading} {session['phase']} ({session['status']})", '']
            current = self.files.read(path / 'agent.json').get('agent')
            if isinstance(current, dict):
                lines += render(current, current_turn=True)
            elif session.get('result'):
                lines += message_lines('Assistant', json.dumps(session['result']))
            else:
                reader, output = self.phase_outputs.setdefault(path, (LogReader(path / 'stdout.log', None), EventOutput()))
                for line in reader.read(flush=session.get("status") != "running"):
                    output.append(line)
                lines += output.read()
            request = self.files.read(path / 'human.request.json')
            if request:
                lines += ['Human help', request.get('summary', ''), request.get('prompt', ''), '']
                answer = self.files.read(path / 'human.result.json')
                if answer:
                    lines += [f"Human: {answer.get('action', '')}", answer.get('guidance', ''), '']
        if isinstance(current, dict) and self.live and self.live['parentId'] == current.get('session', {}).get('leafId'):
            lines += render_live(self.live) if self.live['blocks'] else []
        return lines

    def read_stream(self, *, flush=False):
        for line in self.reader.read(flush=flush):
            self.events.append(line)
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("type") in ("goal.phase_started", "senate.phase_started"):
                self.live = None
            elif event.get("type") == "agent.message_started":
                self.live = {"parentId": event.get("parentId"), "blocks": {}}
            elif event.get("type") == "agent.message_delta" and self.live is not None:
                kind, index, delta = event.get("kind"), event.get("contentIndex"), event.get("delta")
                if not isinstance(kind, str) or kind not in {"text", "thinking"} or type(index) is not int or index < 0 or not isinstance(delta, str):
                    continue
                block = self.live["blocks"].setdefault(index, (kind, []))
                if block[0] == kind:
                    block[1].append(delta)
