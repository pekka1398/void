import { add, sub, scale, dot, cross, normalize, distance, type Vec3 } from '../../orbit/src/orbit/Vec3';
import { quatMultiply, quatToMatrix, matVec } from '../../landing/src/vessel/Attitude';
export { add, sub, scale, dot, cross, normalize, distance, quatMultiply };
export type { Vec3 };
export interface Quat { x: number; y: number; z: number; w: number }
export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
export const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
export const G0 = 9.80665;
export const rotate = (q: Quat, v: Vec3): Vec3 => matVec(quatToMatrix(q), v);

export interface AttachNode { id: string; position: Vec3; direction: Vec3; size: number }
export type Module =
  | { kind: 'command' }
  | { kind: 'tank'; capacityKg: number }
  | { kind: 'engine'; thrustNewtons: number; ispSeconds: number; direction: Vec3 }
  | { kind: 'decoupler'; nodeId: string; impulseNs: number };
export interface PartDefinition {
  id: string; name: string; description: string; category: 'command' | 'tank' | 'engine' | 'decoupler';
  dryMassKg: number; height: number; radius: number; shape: 'cylinder' | 'cone'; color: string;
  crossfeed: boolean; nodes: readonly AttachNode[]; modules: readonly Module[];
}
export interface PartInstance {
  id: string; definitionId: string; fuelKg: number; stage: number | null;
  attachment: { parentId: string; parentNodeId: string; nodeId: string } | null;
}
export interface Craft { version: 1; name: string; parts: PartInstance[] }
export interface Pose { position: Vec3; rotation: Quat }
export interface PlacedPart extends PartInstance { definition: PartDefinition; pose: Pose }
export interface Connection { a: string; nodeA: string; b: string; nodeB: string }
export interface CompiledCraft { craft: Craft; parts: PlacedPart[]; connections: Connection[]; rootId: string }

const nodes = (height: number, top = true, bottom = true): AttachNode[] => [
  ...(top ? [{ id: 'top', position: { x: 0, y: height / 2, z: 0 }, direction: { x: 0, y: 1, z: 0 }, size: 1 }] : []),
  ...(bottom ? [{ id: 'bottom', position: { x: 0, y: -height / 2, z: 0 }, direction: { x: 0, y: -1, z: 0 }, size: 1 }] : []),
];
export const CATALOG: readonly PartDefinition[] = [
  { id: 'pod', name: '指令艙', category: 'command', description: '飛行器的根零件與控制來源', dryMassKg: 300,
    height: 1.6, radius: 0.625, shape: 'cone', color: '#e5e9ec', crossfeed: true, nodes: nodes(1.6, false), modules: [{ kind: 'command' }] },
  { id: 'tank-small', name: '短燃料箱', category: 'tank', description: '700 kg 推進劑 · 適合上面級', dryMassKg: 120,
    height: 1.6, radius: 0.625, shape: 'cylinder', color: '#cbd4dc', crossfeed: true, nodes: nodes(1.6), modules: [{ kind: 'tank', capacityKg: 700 }] },
  { id: 'tank-large', name: '長燃料箱', category: 'tank', description: '2,800 kg 推進劑 · 適合助推級', dryMassKg: 300,
    height: 3.6, radius: 0.625, shape: 'cylinder', color: '#cbd4dc', crossfeed: true, nodes: nodes(3.6), modules: [{ kind: 'tank', capacityKg: 2800 }] },
  { id: 'engine-small', name: '上面級引擎', category: 'engine', description: '30 kN · 真空 Isp 340 s', dryMassKg: 80,
    height: 0.9, radius: 0.625, shape: 'cylinder', color: '#677887', crossfeed: true, nodes: nodes(0.9), modules: [{ kind: 'engine', thrustNewtons: 30_000, ispSeconds: 340, direction: { x: 0, y: 1, z: 0 } }] },
  { id: 'engine-large', name: '助推級引擎', category: 'engine', description: '90 kN · 真空 Isp 310 s', dryMassKg: 240,
    height: 1.2, radius: 0.625, shape: 'cylinder', color: '#677887', crossfeed: true, nodes: nodes(1.2), modules: [{ kind: 'engine', thrustNewtons: 90_000, ispSeconds: 310, direction: { x: 0, y: 1, z: 0 } }] },
  { id: 'decoupler', name: '堆疊分離器', category: 'decoupler', description: '斷開 top 接點 · 阻擋跨級供油', dryMassKg: 50,
    height: 0.3, radius: 0.625, shape: 'cylinder', color: '#d7aa58', crossfeed: false, nodes: nodes(0.3), modules: [{ kind: 'decoupler', nodeId: 'top', impulseNs: 100 }] },
];
export function definition(id: string): PartDefinition {
  const found = CATALOG.find(p => p.id === id);
  if (!found) throw new Error(`Unknown part definition: ${id}`);
  return found;
}
export function node(part: PartDefinition, id: string): AttachNode {
  const found = part.nodes.find(n => n.id === id);
  if (!found) throw new Error(`${part.id} has no node ${id}`);
  return found;
}
export function tankCapacity(part: PartDefinition): number {
  return part.modules.reduce((n, m) => n + (m.kind === 'tank' ? m.capacityKg : 0), 0);
}
export function actionable(part: PartDefinition): boolean { return part.modules.some(m => m.kind === 'engine' || m.kind === 'decoupler'); }

/** Shortest rotation aligning one node normal to the opposite mating normal. */
function align(from: Vec3, to: Vec3): Quat {
  const a = normalize(from), b = normalize(to), d = dot(a, b);
  if (d < -0.999999999) {
    const axis = normalize(cross(a, Math.abs(a.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }));
    return { ...axis, w: 0 };
  }
  const axis = cross(a, b), w = 1 + d, norm = Math.hypot(axis.x, axis.y, axis.z, w);
  return { x: axis.x / norm, y: axis.y / norm, z: axis.z / norm, w: w / norm };
}

/** Craft-local coordinates: +Y is the nose/up axis, metres; attachments derive all poses. */
export function compile(craft: Craft): CompiledCraft {
  if (craft.version !== 1 || typeof craft.name !== 'string' || !craft.name.trim() || !Array.isArray(craft.parts) || craft.parts.length === 0) throw new Error('Craft requires version 1, a name and at least one part');
  if (craft.parts.length > 100) throw new Error('This lab supports at most 100 parts');
  const instances = new Map<string, PartInstance>();
  for (const p of craft.parts) {
    if (!/^[A-Za-z0-9_-]+$/.test(p.id) || instances.has(p.id)) throw new Error(`Invalid or duplicate part id: ${p.id}`);
    const def = definition(p.definitionId);
    if (!Number.isFinite(p.fuelKg) || p.fuelKg < 0 || p.fuelKg > tankCapacity(def)) throw new Error(`${p.id}: fuel outside capacity`);
    if (p.stage !== null && (!Number.isInteger(p.stage) || p.stage < 0 || p.stage > 99 || !actionable(def))) throw new Error(`${p.id}: invalid stage`);
    if (p.attachment !== null && (!p.attachment || typeof p.attachment.parentId !== 'string')) throw new Error(`${p.id}: invalid attachment`);
    instances.set(p.id, p);
  }
  const roots = craft.parts.filter(p => p.attachment === null);
  if (roots.length !== 1 || !definition(roots[0]!.definitionId).modules.some(m => m.kind === 'command')) throw new Error('Craft requires exactly one command root');
  const occupied = new Set<string>(), connections: Connection[] = [], placed = new Map<string, PlacedPart>(), visiting = new Set<string>();
  const claim = (id: string, nodeId: string) => {
    const key = `${id}:${nodeId}`;
    if (occupied.has(key)) throw new Error(`Node already occupied: ${key}`);
    occupied.add(key);
  };
  const place = (p: PartInstance): PlacedPart => {
    const cached = placed.get(p.id); if (cached) return cached;
    if (visiting.has(p.id)) throw new Error('Attachment cycle');
    visiting.add(p.id);
    const def = definition(p.definitionId);
    let pose: Pose = { position: { ...ZERO }, rotation: { ...IDENTITY } };
    if (p.attachment) {
      const a = p.attachment, parentInstance = instances.get(a.parentId);
      if (!parentInstance) throw new Error(`Missing parent ${a.parentId}`);
      const parent = place(parentInstance), pn = node(parent.definition, a.parentNodeId), cn = node(def, a.nodeId);
      if (pn.size !== cn.size) throw new Error('Incompatible node sizes');
      claim(parent.id, pn.id); claim(p.id, cn.id);
      const rotation = align(cn.direction, scale(rotate(parent.pose.rotation, pn.direction), -1));
      pose = { rotation, position: sub(add(parent.pose.position, rotate(parent.pose.rotation, pn.position)), rotate(rotation, cn.position)) };
      connections.push({ a: parent.id, nodeA: pn.id, b: p.id, nodeB: cn.id });
    }
    const result = { ...p, definition: def, pose };
    placed.set(p.id, result); visiting.delete(p.id); return result;
  };
  const parts = craft.parts.map(place);
  return { craft: structuredClone(craft), parts, connections, rootId: roots[0]!.id };
}
export function freeNodes(compiled: CompiledCraft): { partId: string; node: AttachNode; pose: Pose }[] {
  const occupied = new Set(compiled.connections.flatMap(c => [`${c.a}:${c.nodeA}`, `${c.b}:${c.nodeB}`]));
  return compiled.parts.flatMap(p => p.definition.nodes.filter(n => !occupied.has(`${p.id}:${n.id}`)).map(n => ({ partId: p.id, node: n,
    pose: { position: add(p.pose.position, rotate(p.pose.rotation, n.position)), rotation: p.pose.rotation } })));
}
export function addPart(craft: Craft, definitionId: string, parentId: string, parentNodeId: string, nodeId: string): Craft {
  compile(craft);
  const def = definition(definitionId), ids = new Set(craft.parts.map(p => p.id));
  let i = 1; while (ids.has(`p${i}`)) i++;
  const next: Craft = structuredClone(craft);
  next.parts.push({ id: `p${i}`, definitionId, fuelKg: tankCapacity(def), stage: actionable(def) ? 0 : null,
    attachment: { parentId, parentNodeId, nodeId } });
  compile(next); return next;
}
export function removeSubtree(craft: Craft, id: string): Craft {
  const compiled = compile(craft);
  if (id === compiled.rootId) throw new Error('Keep the command root; use New to clear the craft');
  if (!craft.parts.some(p => p.id === id)) throw new Error(`Unknown part ${id}`);
  const removed = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of craft.parts) if (p.attachment && removed.has(p.attachment.parentId) && !removed.has(p.id)) { removed.add(p.id); changed = true; }
  }
  return { ...craft, parts: craft.parts.filter(p => !removed.has(p.id)).map(p => structuredClone(p)) };
}
export function components(compiled: CompiledCraft, cuts: ReadonlySet<string>): string[][] {
  const remaining = new Set(compiled.parts.map(p => p.id)), groups: string[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!; const group = [first]; remaining.delete(first);
    for (let i = 0; i < group.length; i++) for (const c of compiled.connections) {
      if (cuts.has(c.b)) continue;
      const next = c.a === group[i] ? c.b : c.b === group[i] ? c.a : null;
      if (next && remaining.delete(next)) group.push(next);
    }
    groups.push(group);
  }
  return groups;
}
export function fuelSources(compiled: CompiledCraft, engineId: string, cuts: ReadonlySet<string>): string[] {
  if (!compiled.parts.some(p => p.id === engineId && p.definition.modules.some(m => m.kind === 'engine'))) throw new Error(`Unknown engine ${engineId}`);
  const visited = new Set([engineId]), queue = [engineId];
  for (let i = 0; i < queue.length; i++) for (const c of compiled.connections) {
    if (cuts.has(c.b)) continue;
    if (!compiled.parts.find(p => p.id === c.a)!.definition.crossfeed || !compiled.parts.find(p => p.id === c.b)!.definition.crossfeed) continue;
    const next = c.a === queue[i] ? c.b : c.b === queue[i] ? c.a : null;
    if (next && !visited.has(next)) { visited.add(next); queue.push(next); }
  }
  return compiled.parts.filter(p => visited.has(p.id) && tankCapacity(p.definition) > 0).map(p => p.id);
}
export function decouplerConnection(compiled: CompiledCraft, partId: string): Connection {
  const part = compiled.parts.find(p => p.id === partId);
  const module = part?.definition.modules.find(m => m.kind === 'decoupler');
  if (!module || module.kind !== 'decoupler') throw new Error(`Unknown decoupler ${partId}`);
  const connection = compiled.connections.find(c => c.a === partId && c.nodeA === module.nodeId || c.b === partId && c.nodeB === module.nodeId);
  if (!connection) throw new Error(`${partId}: decoupler ${module.nodeId} node is not connected`);
  return connection;
}
export function summary(compiled: CompiledCraft, fuel: ReadonlyMap<string, number> = new Map(compiled.parts.map(p => [p.id, p.fuelKg]))): { dryMassKg: number; fuelKg: number; massKg: number; center: Vec3 } {
  let dryMassKg = 0, fuelKg = 0, weighted = { ...ZERO };
  for (const p of compiled.parts) {
    const f = fuel.get(p.id); if (f === undefined) throw new Error(`Missing fuel state: ${p.id}`);
    dryMassKg += p.definition.dryMassKg; fuelKg += f;
    weighted = add(weighted, scale(p.pose.position, p.definition.dryMassKg + f));
  }
  const massKg = dryMassKg + fuelKg;
  return { dryMassKg, fuelKg, massKg, center: scale(weighted, 1 / massKg) };
}
export function freshCraft(): Craft { return { version: 1, name: 'Untitled rocket', parts: [{ id: 'p1', definitionId: 'pod', fuelKg: 0, stage: null, attachment: null }] }; }
export function demoCraft(): Craft {
  let craft = freshCraft(); craft.name = 'Two-stage test rocket';
  for (const [def, parent] of [['tank-small','p1'],['engine-small','p2'],['decoupler','p3'],['tank-large','p4'],['engine-large','p5']]) craft = addPart(craft, def!, parent!, 'bottom', 'top');
  craft.parts.find(p => p.id === 'p3')!.stage = 1; craft.parts.find(p => p.id === 'p4')!.stage = 1;
  return craft;
}
/** Untrusted JSON is validated before the editor replaces its craft. */
export function importCraft(text: string): Craft { const craft = JSON.parse(text) as Craft; compile(craft); return structuredClone(craft); }
export function exportCraft(craft: Craft): string { compile(craft); return JSON.stringify(craft, null, 2); }
