import type RAPIER from '@dimforge/rapier3d-compat';
import { add, sub, scale, cross, rotate, quatMultiply, ZERO, IDENTITY, G0, compile, components, fuelSources, decouplerConnection,
  type Craft, type CompiledCraft, type Vec3, type Quat, type PlacedPart, type Pose } from './model';

type Rapier = typeof RAPIER;
export const STEP_SECONDS = 1 / 60;
export const LAB_GRAVITY = 9.81;
interface Group { ids: string[]; body: RAPIER.RigidBody; colliders: Map<string, RAPIER.Collider> }
export interface FlightInput { throttle: number; turn: Vec3 }

/** Local test range: compound rigid vessels over flat ground; every separated group stays live. */
export class AssemblyFlight {
  readonly compiled: CompiledCraft;
  readonly world: RAPIER.World;
  readonly fuel = new Map<string, number>();
  readonly lit = new Set<string>();
  readonly firing = new Map<string, number>();
  readonly cuts = new Set<string>();
  readonly stages: number[];
  groups: Group[] = [];
  nextStage = 0;
  time = 0;

  constructor(private readonly rapier: Rapier, craft: Craft, gravity = LAB_GRAVITY) {
    this.compiled = compile(craft);
    this.stages = [...new Set(this.compiled.parts.flatMap(p => p.stage === null ? [] : [p.stage]))].sort((a,b) => a-b);
    for (const p of this.compiled.parts) {
      this.fuel.set(p.id, p.fuelKg);
      for (const m of p.definition.modules) {
        if ((m.kind === 'engine' || m.kind === 'decoupler') && p.stage === null) throw new Error(`${p.id}: assign a stage before launch`);
        if (m.kind === 'decoupler') decouplerConnection(this.compiled, p.id);
      }
    }
    if (!this.compiled.parts.some(p => p.definition.modules.some(m => m.kind === 'engine'))) throw new Error('Add an engine before launch');
    this.world = new rapier.World({ x: 0, y: -gravity, z: 0 });
    this.world.timestep = STEP_SECONDS;
    this.world.createCollider(rapier.ColliderDesc.cuboid(100000, 0.1, 100000).setTranslation(0,-0.1,0).setFriction(0.8));
    const low = Math.min(...this.compiled.parts.map(p => p.pose.position.y - p.definition.height / 2));
    this.groups.push(this.createGroup(this.compiled.parts.map(p => p.id), { x: 0, y: -low + 0.04, z: 0 }, IDENTITY, ZERO, ZERO));
  }

  private part(id: string): PlacedPart {
    const p = this.compiled.parts.find(p => p.id === id); if (!p) throw new Error(`Unknown part ${id}`); return p;
  }
  private group(id: string): Group {
    const g = this.groups.find(g => g.ids.includes(id)); if (!g) throw new Error(`No physical group for ${id}`); return g;
  }
  private applyMass(collider: RAPIER.Collider, p: PlacedPart): void {
    const mass = p.definition.dryMassKg + this.fuel.get(p.id)!;
    const { radius:r, height:h } = p.definition;
    // Authored part origin is its mass centre. Inertia uses a bounding cylinder for this lab.
    collider.setMassProperties(mass, ZERO, { x: mass*(3*r*r+h*h)/12, y: mass*r*r/2, z: mass*(3*r*r+h*h)/12 }, IDENTITY);
  }
  private createGroup(ids: string[], position: Vec3, rotation: Quat, velocity: Vec3, angularVelocity: Vec3): Group {
    const R = this.rapier;
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(position.x,position.y,position.z)
      .setRotation(rotation).setLinvel(velocity.x,velocity.y,velocity.z).setAngvel(angularVelocity)
      .setAngularDamping(0.7).setCcdEnabled(true));
    const colliders = new Map<string, RAPIER.Collider>();
    for (const id of ids) {
      const p = this.part(id), d = p.definition;
      const desc = d.shape === 'cone' ? R.ColliderDesc.cone(d.height/2,d.radius) : R.ColliderDesc.cylinder(d.height/2,d.radius);
      desc.setTranslation(p.pose.position.x,p.pose.position.y,p.pose.position.z).setRotation(p.pose.rotation).setFriction(0.8).setRestitution(0);
      const collider = this.world.createCollider(desc,body); this.applyMass(collider,p); colliders.set(id,collider);
    }
    body.recomputeMassPropertiesFromColliders();
    return { ids, body, colliders };
  }
  partPose(id: string): Pose {
    const p = this.part(id), body = this.group(id).body;
    return { position: add(body.translation(),rotate(body.rotation(),p.pose.position)), rotation: quatMultiply(body.rotation(),p.pose.rotation) };
  }
  get controlledBody(): RAPIER.RigidBody { return this.group(this.compiled.rootId).body; }
  get controlledPartIds(): string[] { return this.group(this.compiled.rootId).ids; }

  /** Removing an attachment rebuilds connected components while preserving every part's pose and velocity. */
  private decouple(id: string): void {
    const p = this.part(id), module = p.definition.modules.find(m => m.kind === 'decoupler')!;
    if (module.kind !== 'decoupler') throw new Error('Expected decoupler');
    const c = decouplerConnection(this.compiled,id);
    if (this.cuts.has(c.b)) throw new Error(`Connection already separated: ${c.b}`);
    const old = this.group(id), position = { ...old.body.translation() }, rotation = { ...old.body.rotation() };
    const oldCenter = { ...old.body.worldCom() }, velocity = { ...old.body.linvel() }, spin = { ...old.body.angvel() };
    const partPose = this.partPose(id), n = p.definition.nodes.find(n => n.id === module.nodeId)!;
    const point = add(partPose.position,rotate(partPose.rotation,n.position)), normal = rotate(partPose.rotation,n.direction);
    this.cuts.add(c.b);
    const subsets = components(this.compiled,this.cuts).filter(ids => ids.some(part => old.ids.includes(part)));
    if (subsets.length !== 2) throw new Error(`Decoupling must split one tree into two groups; got ${subsets.length}`);
    const replacements = subsets.map(ids => {
      const group = this.createGroup(ids,position,rotation,velocity,spin);
      group.body.setLinvel(add(velocity,cross(spin,sub(group.body.worldCom(),oldCenter))),true);
      return group;
    });
    this.world.removeRigidBody(old.body);
    this.groups = [...this.groups.filter(g => g !== old),...replacements];
    const own = this.group(id), other = replacements.find(g => g !== own)!;
    own.body.applyImpulseAtPoint(scale(normal,-module.impulseNs),point,true);
    other.body.applyImpulseAtPoint(scale(normal,module.impulseNs),point,true);
  }
  stage(): number | null {
    const stage = this.stages[this.nextStage]; if (stage === undefined) return null;
    const parts = this.compiled.parts.filter(p => p.stage === stage);
    for (const p of parts) if (p.definition.modules.some(m => m.kind === 'decoupler')) this.decouple(p.id);
    for (const p of parts) if (p.definition.modules.some(m => m.kind === 'engine')) this.lit.add(p.id);
    this.nextStage++; return stage;
  }
  step(input: FlightInput): void {
    if (!(input.throttle >= 0 && input.throttle <= 1) || !Object.values(input.turn).every(Number.isFinite)) throw new Error('Invalid flight input');
    this.firing.clear();
    const burns: { id: string; impulse: number; direction: Vec3 }[] = [];
    for (const id of this.lit) {
      const p = this.part(id), engine = p.definition.modules.find(m => m.kind === 'engine')!;
      if (engine.kind !== 'engine') throw new Error('Expected engine');
      const sources = fuelSources(this.compiled,id,this.cuts), available = sources.reduce((n,id) => n+this.fuel.get(id)!,0);
      const requested = engine.thrustNewtons*input.throttle/(engine.ispSeconds*G0)*STEP_SECONDS;
      const burned = Math.min(available,requested), fraction = requested > 0 ? burned/requested : 0;
      if (available > 0 && burned > 0) for (const tank of sources) this.fuel.set(tank, Math.max(0,this.fuel.get(tank)!*(1-burned/available)));
      this.firing.set(id,input.throttle*fraction);
      burns.push({ id, impulse: engine.thrustNewtons*input.throttle*fraction*STEP_SECONDS, direction: engine.direction });
    }
    for (const group of this.groups) {
      for (const id of group.ids) this.applyMass(group.colliders.get(id)!,this.part(id));
      group.body.recomputeMassPropertiesFromColliders();
    }
    for (const burn of burns) {
      const pose = this.partPose(burn.id);
      this.group(burn.id).body.applyImpulseAtPoint(scale(rotate(pose.rotation,burn.direction),burn.impulse),pose.position,true);
    }
    const body = this.controlledBody;
    body.applyTorqueImpulse(rotate(body.rotation(),scale(input.turn,body.mass()*STEP_SECONDS*2)),true);
    this.world.step(); this.time += STEP_SECONDS;
  }
  dispose(): void { this.world.free(); }
}
