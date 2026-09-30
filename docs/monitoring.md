# Monitor runs and inspect evidence

```sh
asys status            # is the setup running: system, services, active runs
asys ps
asys status RUN
asys logs RUN
asys logs RUN JOB --stream stderr
asys top RUN
asys dashboard --root ./state
```

Every execution shape writes ordinary run/job records. Observation takes the
same asys `--root` as execution. A root can contain runs from several dcomp
systems; the dashboard's system filter selects among them and survives refresh.

The workflow view distinguishes worker kinds, branches and return paths.
Program tasks expose results and logs. Senate and swarm selections connect to
the common inspector and console. Display freeze, recorded-frame replay and
execution pause/cancel have separate meanings.

[The operations guide](../skills/asys/references/operations.md) explains logs,
transcripts, Human answers, failure recovery and controls.
[The command reference](../skills/asys/references/commands.md) defines all options.
[Dashboard design packages](../skills/asys-authoring/references/design.md) change
appearance independently of records and execution.
