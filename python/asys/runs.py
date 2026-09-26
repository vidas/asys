"""Read run records and the public runtime job files without contacting Docker.

Observers never acknowledge channels or change run or job state. Job stdout
and stderr remain available after components have been removed.
"""
from collections import Counter
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import time

from .state import state_root

TERMINAL = {"completed", "failed", "cancelled", "recovery-required"}
JOB_TERMINAL = {"done", "failed", "cancelled", "interrupted"}


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def clean(value):
    return "".join(c if c.isprintable() else " " for c in str(value)).strip()


def seconds(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError, TypeError):
        return None


def duration(start, end=None):
    beginning = seconds(start)
    if beginning is None:
        return "-"
    elapsed = max(0, int((seconds(end) or time.time()) - beginning))
    if elapsed >= 86400:
        return f"{elapsed // 86400}d {elapsed % 86400 // 3600}h"
    if elapsed >= 3600:
        return f"{elapsed // 3600}h {elapsed % 3600 // 60}m"
    return f"{elapsed // 60}m {elapsed % 60}s" if elapsed >= 60 else f"{elapsed}s"


class Files:
    """Cache parsed records until their inode, size, or modification time changes."""
    def __init__(self):
        self.cache = {}

    def read(self, path, fields=None):
        path = Path(path)
        try:
            stat = path.stat()
        except FileNotFoundError:
            return {}
        key = (path, tuple(fields) if fields else None)
        signature = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
        previous = self.cache.get(key)
        if previous and previous[0] == signature:
            return previous[1]
        try:
            value = json.loads(path.read_text())
        except FileNotFoundError:
            return {}
        if not isinstance(value, dict):
            raise ValueError(f"{path}: expected a JSON object")
        if fields:
            value = {key: value[key] for key in fields if key in value}
        self.cache[key] = (signature, value)
        return value


def tail(path, lines=20):
    try:
        with Path(path).open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            offset = max(0, stream.tell() - 256 * 1024)
            stream.seek(offset)
            data = stream.read()
        if offset:
            data = data.partition(b"\n")[2]
        return data.decode("utf-8", errors="replace").splitlines()[-lines:] if lines else []
    except FileNotFoundError:
        return []


def last_line(path):
    return next((clean(line) for line in reversed(tail(path, 12)) if line.strip()), "")


def launcher_state(directory):
    try:
        with (directory / "launcher.lock").open("rb") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                return "running"
            return "stopped"
    except FileNotFoundError:
        return "unknown"  # The producer does not advertise launcher liveness.


class Runs:
    def __init__(self, root):
        from .progress import AgentProgress
        self.root = Path(root).expanduser().resolve()
        self.files = Files()
        self.progress = AgentProgress()

    def directories(self):
        if (self.root / "run.json").is_file():
            return [self.root]
        if not self.root.exists():
            return []
        return sorted((path for path in self.root.iterdir() if (path / "run.json").is_file()),
                      key=lambda path: (path / "run.json").stat().st_mtime, reverse=True)

    def select(self, selector=None):
        if selector and ("/" in selector or selector in {".", ".."}):
            path = Path(selector).expanduser().resolve()
            if path.name == "run.json":
                path = path.parent
            if not (path / "run.json").is_file():
                raise ValueError(f"No saved run at {path}")
            return path
        paths = self.directories()
        if not selector or selector == "latest":
            if not paths:
                raise ValueError(f"No saved runs under {self.root}")
            return paths[0]
        exact = [path for path in paths if path.name == selector]
        matches = exact or [path for path in paths if path.name.startswith(selector)]
        if len(matches) != 1:
            if matches:
                raise ValueError(f"Ambiguous run {selector!r}: " + ", ".join(path.name for path in matches))
            raise ValueError(f"No run matching {selector!r} under {self.root}")
        return matches[0]

    def jobs(self, directory):
        roots = list((directory / "runtime/environments").glob("*/jobs"))
        jobs = []
        for root in roots:
            for path in root.glob("*/state.json"):
                state = self.files.read(path, ["id", "type", "status", "submitted_at", "started_at", "finished_at", "error", "exit_code"])
                request = self.files.read(path.parent / "request.json", ["metadata", "type", "directory", "workspace"])
                metadata = request.get("metadata", {})
                execution = (root.parent / request["directory"]).resolve()
                workspace = (root.parent / request["workspace"]).resolve()
                name = metadata.get("name") or state.get("id") or path.parent.name
                detail = last_line(execution / "stderr.log") if state.get("status") == "failed" else ""
                detail = detail or state.get("error") or last_line(execution / "stdout.log")
                try:
                    event = json.loads(detail)
                    if isinstance(event, dict) and "type" in event:
                        detail = f"{event['type']}{': ' + event['name'] if event.get('name') else ''}"
                except (ValueError, TypeError):
                    pass
                jobs.append({**state, "id": state.get("id", path.parent.name), "name": name,
                             "environment": metadata.get("environment") or root.parent.name,
                             "directory": str(execution), "workspace": str(workspace), "metadata": metadata,
                             "detail": clean(detail), "elapsed": duration(state.get("started_at"), state.get("finished_at"))})
        for job in jobs:
            agent = self.progress.observe(job)
            if agent:
                job["agent"] = agent
                if job.get("status") == "running":
                    job["detail"] = clean(agent["detail"])
        return sorted(jobs, key=lambda job: (job.get("submitted_at", ""), job["id"]))

    def snapshot(self, directory):
        record = dict(self.files.read(directory / "run.json"))
        record.setdefault("id", directory.name)
        record["directory"] = str(directory)
        record["name"] = record.get("name") or record["id"]
        # A component can publish completion after its host launcher has died.
        # Inspect the channel without advancing the shared acknowledgement cursor.
        if record.get("status") not in TERMINAL and record.get("channel"):
            channel = Path(record["channel"])
            if not channel.is_absolute():
                channel = directory / channel
            for path in sorted((channel / "out").glob("[0-9]*.json"), reverse=True):
                if int(path.stem) <= record.get("channel_after", 0):
                    break
                event = self.files.read(path)
                if (event.get("type") == "run.result" and event.get("data", {}).get("runId") == record["id"]
                        and event["data"].get("status") in TERMINAL):
                    record.update(status=event["data"]["status"], error=event["data"].get("error", ""), finished_at=event.get("time"))
                    break
        record["launcher"] = launcher_state(directory)
        record["reported_status"] = record.get("status", "unknown")
        if record["reported_status"] not in TERMINAL and record["launcher"] == "stopped":
            record["status"] = "detached"
        record["jobs"] = self.jobs(directory)
        record["job_counts"] = dict(Counter(job.get("status", "unknown") for job in record["jobs"]))
        if record.get("status") == "failed" and re.fullmatch(r"Program exited with status -?\d+", record.get("error", "")):
            failed = next((job for job in reversed(record["jobs"]) if job.get("status") == "failed" and job["detail"]), None)
            if failed:
                record["error"] = f"{failed['name']}: {failed['detail']}"
        created, finished = record.get("created_at"), record.get("finished_at")
        if not created:
            try:
                with (directory / "events.jsonl").open() as stream:
                    created = json.loads(stream.readline()).get("time")
            except (OSError, ValueError):
                created = next((job.get("submitted_at") or job.get("started_at") for job in record["jobs"]), None)
        if not finished and record.get("status") in TERMINAL:
            try:
                event = json.loads(next(iter(tail(directory / "events.jsonl", 1)), "{}"))
                if event.get("type") in {"run.completed", "run.failed", "run.cancelled"}:
                    finished = event.get("time")
            except ValueError:
                pass
            finished = finished or record.get("updated_at") or datetime.fromtimestamp((directory / "run.json").stat().st_mtime, timezone.utc).isoformat()
        record["elapsed"] = duration(created, finished)
        return record


def select_jobs(jobs, selector):
    if not selector:
        return jobs
    named = [job for job in jobs if job["name"] == selector]
    if named:
        return named
    exact = [job for job in jobs if job["id"] == selector]
    matches = exact or [job for job in jobs if job["id"].startswith(selector)]
    if len(matches) > 1:
        raise ValueError(f"Ambiguous job {selector!r}; use its full ID or job name")
    return matches


def table(headers, rows):
    rows = [[clean(value) for value in row] for row in rows]
    widths = [max([len(header)] + [len(row[i]) for row in rows]) for i, header in enumerate(headers)]
    return "\n".join("  ".join(value.ljust(widths[i]) for i, value in enumerate(row)).rstrip() for row in [headers, *rows])


def status(args):
    runs = Runs(state_root('runs', root=args.root))
    paths = [runs.select(args.run)] if args.run else runs.directories()
    records = [runs.snapshot(path) for path in paths]
    if args.json:
        print(json.dumps(records[0] if args.run else records, indent=2, ensure_ascii=False))
        return
    if not records:
        print(f"No saved runs under {runs.root}")
        return
    if not args.run:
        print(table(["RUN", "NAME", "ENVIRONMENT", "STATUS", "JOBS", "ELAPSED", "DETAIL"], [
            [r["id"][:8], r["name"], r.get("environment", "-"), r.get("status", "unknown"),
             f"{r['job_counts'].get('running', 0)}/{len(r['jobs'])}", r["elapsed"], r.get("error", "")]
            for r in records]))
        return
    record = records[0]
    print(f"{record['name']}  {record['id']}\nStatus: {record.get('status')}  Environment: {record.get('environment', '-')}  Elapsed: {record['elapsed']}")
    print(f"State: {record['directory']}")
    for role, name in record.get("components", {}).items():
        print(f"{role}: {name}")
    if record.get("error"):
        print(f"Error: {record['error']}")
    for name, health in record.get('component_health', {}).items():
        print(f"Health: {name}: {health['state']} (since {health.get('since', 'unknown')})")
    if record.get("status") == "detached":
        print(f"Launcher exited; last reported run status: {record['reported_status']}. Components may still be running.")
    if record["jobs"]:
        print()
        print(table(["NAME", "JOB", "TYPE", "STATUS", "ELAPSED", "DETAIL"], [
            [j["name"], j["id"][:12], j.get("type", "-"), j.get("status", "unknown"), j["elapsed"], j["detail"]]
            for j in record["jobs"]]))


class LogReader:
    def __init__(self, path, lines):
        self.path, self.lines = path, lines
        self.offset = None
        self.identity = None
        self.pending = b""

    def read(self, *, flush=False):
        try:
            with self.path.open("rb") as stream:
                stat = os.fstat(stream.fileno())
                initial = self.offset is None
                if initial or stat.st_ino != self.identity or stat.st_size < self.offset:
                    self.offset, self.pending = 0, b""
                self.identity = stat.st_ino
                if initial:
                    stream.seek(0 if self.lines is None else max(0, stat.st_size - 256 * 1024))
                    if stream.tell():
                        stream.readline()
                    data = stream.read().splitlines(keepends=True)
                    chunk = b"".join(data if self.lines is None else data[-self.lines:]) if self.lines != 0 else b""
                else:
                    stream.seek(self.offset)
                    chunk = stream.read(256 * 1024)
                self.offset = stream.tell()
        except FileNotFoundError:
            return []
        lines = (self.pending + chunk).split(b"\n")
        self.pending = lines.pop()
        if flush and self.pending:
            lines.append(self.pending)
            self.pending = b""
        return [line.decode("utf-8", errors="replace") for line in lines]


def run_log(record):
    return Path(record["directory"]) / "run.log"


def default_root():
    return state_root("runs")


def log_sources(record, args):
    directory = Path(record["directory"])
    if args.source != "jobs":
        filename = {"run": run_log(record).name, "events": "events.jsonl", "components": "components.log", "commands": "commands.log"}[args.source]
        return [(args.source, directory / filename)]
    streams = ["stdout", "stderr"] if args.stream == "both" else [args.stream]
    sources = []
    for job in select_jobs(record["jobs"], args.job):
        for stream in streams:
            label = f"{job['name']} {job['id'][:12]} {stream}"
            sources.append((label, Path(job['directory']) / f"{stream}.log"))
    return sources


def logs(args):
    runs = Runs(state_root('runs', root=args.root))
    directory = runs.select(args.run)
    readers = {}
    emitted = False
    while True:
        record = runs.snapshot(directory)
        jobs = select_jobs(record["jobs"], args.job)
        if args.job and not jobs and (not args.follow or record.get("status") in TERMINAL):
            raise ValueError(f"No job matching {args.job!r} in run {record['id']}")
        for label, path in log_sources(record, args):
            reader = readers.setdefault(path, LogReader(path, args.lines))
            for line in reader.read(flush=not args.follow or record.get("status") in TERMINAL):
                print(f"[{clean(label)}] {clean(line)}" if args.source == "jobs" else clean(line), flush=True)
                emitted = True
        if not args.follow:
            if not emitted:
                print("No log output yet.")
            return
        # A final rescan includes files created immediately before completion.
        if record.get("status") in TERMINAL and all(j.get("status") in JOB_TERMINAL for j in jobs):
            return
        time.sleep(.2)
