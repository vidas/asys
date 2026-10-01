# Advanced BPMN patterns (the earlier format)

Use a normal named worker for each executing activity. These BPMN constructs
change when assignments run; they do not introduce another host launcher or a
different environment per child.

## Collections and repeated work

```xml
<bpmn:task id="inspect_parts" name="Inspect each part">
  <bpmn:extensionElements>
    <asys:job type="reviewer" input='= {request: "Inspect part " + part.name}'/>
  </bpmn:extensionElements>
  <bpmn:multiInstanceLoopCharacteristics isSequential="false">
    <bpmn:loopDataInputRef>parts</bpmn:loopDataInputRef>
    <bpmn:inputDataItem id="part" name="part"/>
  </bpmn:multiInstanceLoopCharacteristics>
</bpmn:task>
```

Produce the `parts` collection in an earlier job or data mapping. The request
Markdown does not become a collection automatically. Every instance gets a
fresh job, while results retain collection order. Set `isSequential="true"`
when instances edit the same files. Parallel instances are not a worker-pool
size setting.

Standard loops support `loopCounter`, `testBefore`, `loopMaximum` and a FEEL
`loopCondition`. Multi-instance work supports `loopCardinality` and
`completionCondition`, including counters such as `numberOfCompletedInstances`.
Use a gateway loop when review findings and the revision branch should remain
explicit in the process.

## Agent-selected work

An `adHocSubProcess` can bind its own coordinator job and contain ordinary bound
child activities. Define a named coordinator agent and put this in its
`agents/NAME/extensions/bpmn.mjs`:

```js
export {default} from '/opt/asys/asys-workers/extensions/bpmn.mjs';
```

The extension supplies `list_actions`, `start_action`, and `wait_action`. A call
like `{"action":"design_module","input":{"module":{"name":"power"}}}`
makes that input available to the child's binding as `message.module.name`.
Do not add another `message` wrapper unless the binding expects it.

Children without incoming flows are enabled; sequence flows constrain later
eligibility. The coordinator explicitly selects enabled children. Sequential
ordering permits one active selection; parallel ordering permits different
activities together. The same activity cannot have concurrent selected
invocations. Use multi-instance work for that shape.

Coordinator completion ends a subprocess without a completion condition. With
one, completion is evaluated as children finish. `cancelRemainingInstances="false"`
waits for active children. The subprocess output contains child results and
the coordinator report under `result`.

## Data and called processes

Use standard `ioSpecification`, `dataInputAssociation` and
`dataOutputAssociation` for data-object mappings. FEEL transformations support
multiple sources. These pass values, not files; artifacts remain in the workspace.

A `callActivity` selects a process in the loaded document with
`calledElement="PROCESS_ID"`. The called process shares the same environment.
Dynamic process selection requires compatibility with all possible target
processes. For a simple handoff, an explicit result variable and next input are
usually sufficient.

## Waiting and embedding

An unbound receive task waits for a message without an agent process. BPMN
timers can bound waiting or interrupt activities. A human userTask instead
creates a job that talks to the separate Human service.

The Workflow component exposes `asys.workflow.v1.Workflow`. Integration clients
use `LoadWorkflow`, `Describe`, `CheckWorkflow`, `StartRun`, `GetRun`, `ListRuns`,
`ResumeRun`, `CancelRun`, `SendMessage` and `GetEvents`. The runtime host channel
supports `start`, `resume`, `cancel` and `message` requests. Use the runtime
channel library rather than constructing event filenames manually.

There is no public message-sending CLI implied by these APIs. An embedding
application owns that integration and must use the installed protocol version.
Validate checkpoint compatibility before trying to recover a run created by a
different engine adapter.
