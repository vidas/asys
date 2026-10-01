"""Workflow progress from the published event history, without acknowledgements."""
import json
from pathlib import Path

from asys.runs import LogReader, TERMINAL, clean, duration, seconds


def agent_notices(notices):
    for notice in sorted(notices, key=lambda item: seconds(item["time"]) or seconds(item["job"].get("started_at")) or 0):
        job = notice["job"]
        name, activity = job.get("name") or job["activity"], job["activity"]
        label = f"{name} ({activity})" if name != activity else activity
        when = notice["time"] or "(time not recorded)"
        yield notice["key"], clean(f"{when}  {notice['status'].upper():<9} {label} — {notice['detail']}")


# Workflow file step events, as the BPMN activity events they correspond to.
STEP_EVENTS = {"step.started": "activity.start", "step.completed": "activity.end", "step.waiting": "activity.wait",
               "step.failed": "step.failed"}


class WorkflowHistory:
    def __init__(self, directory=None):
        self.directory = Path(directory) if directory else None
        self.mirror = LogReader(self.directory / "events.jsonl", None) if self.directory else None
        self.after = self.channel_after = 0
        self.executions = {}
        self.counts = {}
        self.last_error = ""

    def read(self, record):
        # The launcher mirror retains history even if the channel is pruned.
        # The channel supplies events committed after the launcher last read it.
        # Both carry the same store sequence, so overlap is consumed once.
        for line in self.mirror.read():
            self.consume(json.loads(line), record)
        outbound = self.directory / "runtime/channels/workflow/out"
        for path in sorted(outbound.glob("[0-9]*.json")):
            if not path.stem.isdigit() or int(path.stem) <= self.channel_after:
                continue
            try:
                event = json.loads(path.read_text())
            except FileNotFoundError:
                continue  # A reader may be pruning already acknowledged events.
            self.channel_after = int(path.stem)
            body = event.get("data", {})
            if body.get("runId") == record["id"] and "activityId" in body:
                self.consume({"sequence": body["store"], "type": event["type"], "activityId": body["activityId"],
                              "time": body["time"], "data": body.get("data", {})}, record)

    def consume(self, event, record):
        # Protobuf JSON uses decimal strings for uint64; channel events use integers.
        sequence = int(event.get("sequence", self.after + 1))
        if sequence <= self.after:
            return None
        self.after = sequence
        kind = event["type"]
        data = event.get("data") or json.loads(event.get("dataJson") or "{}")
        activity = event.get("activityId", "")
        when = event.get("time", "")
        execution = data.get("executionId")
        if kind in STEP_EVENTS:
            # Workflow files report steps as BPMN reports activities. One frame
            # runs one execution of a step at a time.
            kind, execution = STEP_EVENTS[kind], f"{data.get('frame', '')}:{activity}"
            if data.get("file") and data["file"] != record.get("workflow_root", data["file"]):
                activity = f"{data['file']}:{activity}"
        jobs = record.get("jobs", [])
        job = next((job for job in jobs if data.get("jobId") == job["id"] or
                    (execution and execution == job.get("execution_id"))), None)
        internal = data.get("internal", False) or bool(job and job["activity"] != activity)
        if internal and kind.startswith("activity."):
            return None
        if internal and job:
            activity = job["activity"]
        job = job or next((job for job in reversed(jobs) if job["activity"] == activity), None)
        name = data.get("name") or (job and job.get("name")) or activity
        label = f"{name} ({activity})" if name != activity else activity
        key = (activity, execution or activity)
        stage = self.executions.get(key)
        if not stage and kind in {"job.failed", "job.created"}:
            stage = next((item for item in reversed(list(self.executions.values()))
                          if item["activity"] == activity and item["status"] in {"running", "waiting"}), None)
        if stage:
            label = stage["label"]

        def emit(state, subject, detail=""):
            line = f"{when}  {state:<9} {subject}" + (f" — {detail}" if detail else "")
            return clean(line)

        if kind.startswith("run."):
            statuses = {"run.created": ("RUN STARTED", "running"), "run.recovered": ("RUN RESUMED", "running"),
                        "run.completed": ("RUN COMPLETED", "completed"), "run.failed": ("RUN FAILED", "failed"),
                        "run.cancelled": ("RUN CANCELLED", "cancelled")}
            if kind not in statuses:
                return None
            state, status = statuses[kind]
            if status in TERMINAL:
                for item in self.executions.values():
                    if item["status"] in {"running", "waiting"}:
                        item["status"] = "cancelled" if status == "cancelled" else "interrupted"
            detail = self.last_error or data.get("message", "") if status == "failed" else ""
            return emit(state, record.get("name") or record["id"], detail)

        if kind == "activity.start":
            self.counts[activity] = self.counts.get(activity, 0) + 1
            iteration = self.counts[activity]
            if iteration > 1:
                label += f" #{iteration}"
            self.executions[key] = {"activity": activity, "label": label, "status": "running", "started_at": when}
            return emit("STARTED", label)
        if kind in {"activity.wait", "activity.timer"} or (kind == "job.created" and data.get("type") == "human"):
            reason = "human response" if kind == "job.created" else "message" if data.get("activityType") == "bpmn:ReceiveTask" else "event"
            if kind == "activity.timer":
                reason = "timer" + (f" until {data['expireAt']}" if data.get("expireAt") else "")
            if data.get("reason"):
                reason = data["reason"]
            detail = f"waiting for {reason}"
            if not stage:
                stage = self.executions.setdefault(key, {"activity": activity, "label": label})
            stage["status"] = "waiting"
            return emit("WAITING", label, detail)
        if kind in {"activity.end", "activity.discard", "job.failed"}:
            state = {"activity.end": "finished", "activity.discard": "discarded", "job.failed": "failed"}[kind]
            detail = ""
            if kind == "job.failed":
                detail = (job and job.get("detail")) or data.get("message", "")
                self.last_error = detail
            if stage:
                stage["status"] = state
            elif kind == "job.failed":
                self.executions[key] = {"activity": activity, "label": label, "status": state}
            if kind == "activity.discard":
                return None
            if kind == "activity.end" and stage and stage.get("started_at"):
                detail = duration(stage["started_at"], when)
            return emit(state.upper(), label, detail)
        if kind == "step.failed":
            self.last_error = data.get("message", "")
            reported = stage and stage.get("status") == "failed"  # its job's failure was reported
            if stage:
                stage["status"] = "failed"
            if reported:
                return None
            routed = f"; continuing at {data['next']}" if data.get("next") else ""
            return emit("FAILED", label, self.last_error + routed)
        if kind == "message.received":
            return emit("RECEIVED", f"message for {data.get('target', '')}")
        return None
