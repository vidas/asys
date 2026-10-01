"""The graph and layout every workflow viewer draws.

Nodes are steps, addressed by path (`search/global_search` inside the group
`search`); groups and repeats are boxes containing their own steps. Edges carry
their role so a viewer can draw them in the style guide's grammar: the main
rail, branches, decisions, error and timeout exits, and return arcs for loops.
Coordinates are grid units: a step is one unit; a viewer chooses pixels.
"""
from . import flow

EDGE_KEYS = (('next', 'next'), ('on_error', 'error'), ('on_timeout', 'timeout'), ('undo', 'undo'))


def graph(workflow, kinds=None):
    """Nodes, edges and boxes for WORKFLOW, laid out left to right."""
    nodes, edges = [], []
    width, height = _scope(workflow.steps, workflow.data.get('start') if isinstance(workflow.data, dict) else None,
                           '', kinds or {}, nodes, edges, 0, 0)
    return {'name': (workflow.data or {}).get('name', workflow.path.stem) if isinstance(workflow.data, dict) else '',
            'nodes': nodes, 'edges': edges, 'width': width, 'height': height}


def _scope(steps, start, prefix, kinds, nodes, edges, x0, y0):
    """Lay out one scope at (x0, y0); return its size in grid units."""
    names = [name for name, step in steps.items() if isinstance(step, dict)]
    path = {name: f'{prefix}{name}' for name in names}
    links = {name: _links(steps[name]) for name in names}
    back = _back_edges(start, links, names)
    layer = _layers(start, links, back, names)
    sizes = {}
    inner = {}
    for name in names:
        step = steps[name]
        if isinstance(step.get('group'), dict) and isinstance(step['group'].get('steps'), dict):
            inner[name] = ('group', step['group']['steps'], step['group'].get('start'))
        elif isinstance(step.get('repeat'), dict) and isinstance(step['repeat'].get('step'), dict):
            inner[name] = ('repeat', {'step': step['repeat']['step']}, 'step')
        sizes[name] = (1, 1)
    # Lay out boxes first, off-screen, to know their size.
    measured = {}
    for name, (_, inner_steps, inner_start) in inner.items():
        probe_nodes, probe_edges = [], []
        w, h = _scope(inner_steps, inner_start, path[name] + '/', kinds, probe_nodes, probe_edges, 0, 0)
        measured[name] = (probe_nodes, probe_edges)
        sizes[name] = (w + 1, h + 1)  # a margin inside the box
    columns = {}
    for name in names:
        columns.setdefault(layer[name], []).append(name)
    x, positions, column_x = x0, {}, {}
    total_height = 1
    for column in sorted(columns):
        members = columns[column]
        column_width = max(sizes[name][0] for name in members)
        heights = [sizes[name][1] for name in members]
        span = sum(heights) + (len(members) - 1) * 0.5
        total_height = max(total_height, span)
        # Centre the column on the rail (y0); alternate above and below.
        y = y0 - span / 2
        for name in members:
            positions[name] = (x, y)
            y += sizes[name][1] + 0.5
        column_x[column] = x
        x += column_width + 1
    for name in names:
        step = steps[name]
        kind = next((k for k in flow.KINDS if k in step), 'unknown')
        nx, ny = positions[name]
        w, h = sizes[name]
        nodes.append(_node(path[name], name, kind, step, kinds, nx, ny, w, h, prefix))
        if name in measured:
            probe_nodes, probe_edges = measured[name]
            for node in probe_nodes:
                node['x'] += nx + 0.5
                node['y'] += ny + h / 2
                nodes.append(node)
            edges.extend(probe_edges)
    for name in names:
        for role, target, label in links[name]:
            if target not in path:
                continue  # a dangling reference: validation reports it; draw what exists
            edges.append({'from': path[name], 'to': path[target], 'role': role,
                          **({'label': label} if label else {}),
                          **({'back': True} if (name, target) in back else {})})
    return x - x0, max(total_height, 1)


def _node(path, name, kind, step, kinds, x, y, w, h, prefix):
    worker = step.get('run') if kind == 'run' else step.get('choose', {}).get('coordinator') if kind == 'choose' else None
    label = step.get('end') if kind == 'end' else step.get('description') or name
    node = {'id': path, 'step': name, 'scope': prefix.rstrip('/'), 'kind': kind, 'label': str(label),
            'x': x, 'y': y, 'w': w, 'h': h}
    if worker:
        node['worker'] = worker
        node['work'] = kinds.get(worker, 'unknown')   # agent, goal, senate, swarm, program, human
    if kind == 'call':
        node['call'] = step['call']
    if 'for_each' in step:
        node['for_each'] = True
    return node


def _links(step):
    """(role, target, label) for every edge leaving STEP within its scope."""
    links = []
    for key, role in EDGE_KEYS:
        if isinstance(step.get(key), str):
            links.append((role, step[key], None))
    if isinstance(step.get('parallel'), list):
        links += [('branch', branch, None) for branch in step['parallel'] if isinstance(branch, str)]
        if isinstance(step.get('join'), str):
            links.append(('join', step['join'], None))
    if isinstance(step.get('switch'), list):
        for case in step['switch']:
            if isinstance(case, dict) and isinstance(case.get('next'), str):
                links.append(('case', case['next'], str(case.get('when', ''))))
        if isinstance(step.get('default'), str):
            links.append(('default', step['default'], None))
    choose = step.get('choose')
    if isinstance(choose, dict):
        links += [('action', action, None) for action in choose.get('actions', []) if isinstance(action, str)]
    if isinstance(step.get('compensate'), str) and step['compensate'] != 'all':
        links.append(('compensate', step['compensate'], None))
    return links


def _back_edges(start, links, names):
    """Edges that return to a step on the current path: revision loops."""
    back, state = set(), {}

    def visit(name):
        state[name] = 'open'
        for _, target, _ in links.get(name, []):
            if target not in links:
                continue
            if state.get(target) == 'open':
                back.add((name, target))
            elif target not in state:
                visit(target)
        state[name] = 'done'
    for root in [start] + names:
        if root in links and root not in state:
            visit(root)
    return back


def _layers(start, links, back, names):
    """Longest distance from start over forward edges; joins sit after branches."""
    layer = {name: 0 for name in names}
    order, seen = [], set()

    def visit(name):
        if name in seen or name not in links:
            return
        seen.add(name)
        for _, target, _ in links[name]:
            if (name, target) not in back:
                visit(target)
        order.append(name)
    for root in [start] + names:
        visit(root)
    for name in reversed(order):
        for role, target, _ in links[name]:
            if (name, target) in back or target not in layer:
                continue
            # A join follows the longest branch, not the fork.
            layer[target] = max(layer[target], layer[name] + (2 if role == 'join' else 1))
    return layer
