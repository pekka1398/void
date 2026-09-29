import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { add, scale, distance, rotate, node, G0, ZERO, compile, demoCraft, freshCraft, addPart, removeSubtree,
  summary, freeNodes, components, fuelSources, decouplerConnection, exportCraft, importCraft } from './src/model';
import { AssemblyFlight, STEP_SECONDS } from './src/runtime';

let checks = 0;
function check(name: string, fn: () => void): void { fn(); checks++; console.log(`✓ ${name}`); }
function near(actual: number, expected: number, tolerance = 1e-5): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected} (±${tolerance})`);
}
const demo = demoCraft(), compiled = compile(demo);
check('authored mass, fuel and available nodes', () => {
  assert.equal(compiled.parts.length, 6);
  assert.equal(summary(compiled).dryMassKg, 1090);
  assert.equal(summary(compiled).fuelKg, 3500);
  assert.equal(summary(compiled).massKg, 4590);
  assert.deepEqual(freeNodes(compiled).map(n => [n.partId,n.node.id]), [['p6','bottom']]);
});
check('every connection has coincident points and opposing normals', () => {
  const reversed = addPart(freshCraft(),'tank-small','p1','bottom','bottom');
  for (const craft of [demo,reversed]) {
    const c = compile(craft);
    for (const connection of c.connections) {
      const a = c.parts.find(p=>p.id===connection.a)!, b = c.parts.find(p=>p.id===connection.b)!;
      const na=node(a.definition,connection.nodeA), nb=node(b.definition,connection.nodeB);
      near(distance(add(a.pose.position,rotate(a.pose.rotation,na.position)),add(b.pose.position,rotate(b.pose.rotation,nb.position))),0);
      near(distance(rotate(a.pose.rotation,na.direction),scale(rotate(b.pose.rotation,nb.direction),-1)),0);
    }
  }
});
check('occupied nodes, invalid resources, roots and cycles reject edits', () => {
  assert.throws(()=>addPart(demo,'tank-small','p1','bottom','top'),/occupied/);
  const bad = structuredClone(demo); bad.parts[1]!.fuelKg=701; assert.throws(()=>compile(bad),/capacity/);
  const roots=structuredClone(demo);roots.parts[1]!.attachment=null;assert.throws(()=>compile(roots),/root/);
  const cycle=structuredClone(demo);cycle.parts[1]!.attachment!.parentId='p3';assert.throws(()=>compile(cycle),/cycle/);
  assert.throws(()=>importCraft('{"version":2}'));
  assert.throws(()=>importCraft('not json'));
  const missing=structuredClone(demo);missing.parts[1]!.attachment!.parentId='missing';assert.throws(()=>compile(missing),/Missing parent/);
});
check('subtree removal and JSON round trip preserve the assembly', () => {
  assert.deepEqual(removeSubtree(demo,'p4').parts.map(p=>p.id),['p1','p2','p3']);
  assert.throws(()=>removeSubtree(demo,'p1'),/root/);
  assert.deepEqual(importCraft(exportCraft(demo)),demo);
  assert.deepEqual(compile(importCraft(exportCraft(demo))).parts.map(p=>p.pose),compiled.parts.map(p=>p.pose));
});
check('crossfeed and severed connections partition the actual graph', () => {
  assert.deepEqual(fuelSources(compiled,'p3',new Set()),['p2']);
  assert.deepEqual(fuelSources(compiled,'p6',new Set()),['p5']);
  assert.deepEqual(components(compiled,new Set(['p4'])),[['p1','p2','p3'],['p4','p5','p6']]);
  assert.equal(decouplerConnection(compiled,'p4').b,'p4');
  let reversed=addPart(freshCraft(),'decoupler','p1','bottom','bottom');
  reversed=addPart(reversed,'tank-small','p2','top','top');
  assert.equal(decouplerConnection(compile(reversed),'p2').b,'p3');
});

await RAPIER.init();
check('physical mass and centre match authored craft data',()=>{
  const flight=new AssemblyFlight(RAPIER,demo,0);
  try {
    near(flight.controlledBody.mass(),4590,0.01);
    const expected=add(summary(compiled).center,flight.partPose('p1').position);
    near(distance(flight.controlledBody.worldCom(),expected),0,1e-4);
  } finally {flight.dispose();}
});
check('idle vehicle rests on the test pad without losing fuel',()=>{
  const flight=new AssemblyFlight(RAPIER,demo);
  try {
    for(let i=0;i<600;i++)flight.step({throttle:0,turn:ZERO});
    assert.ok(flight.partPose('p6').position.y>0.5);
    near(flight.controlledBody.linvel().y,0,0.01);
    near(summary(compiled,flight.fuel).fuelKg,3500);
  } finally {flight.dispose();}
});
check('first stage lifts and consumes only its reachable tank at the Isp rate',()=>{
  const flight=new AssemblyFlight(RAPIER,demo);
  try {
    const height=flight.partPose('p1').position.y;
    assert.equal(flight.stage(),0);
    for(let i=0;i<120;i++)flight.step({throttle:1,turn:ZERO});
    near(flight.fuel.get('p5')!,2800-90000/(310*G0)*120*STEP_SECONDS);
    assert.equal(flight.fuel.get('p2'),700);
    assert.ok(flight.partPose('p1').position.y>height+10);
    assert.ok(flight.controlledBody.linvel().y>10);
  } finally {flight.dispose();}
});
check('separation preserves poses and net linear momentum, then ignites the upper engine',()=>{
  const flight=new AssemblyFlight(RAPIER,demo,0);
  try {
    flight.stage();
    flight.controlledBody.setLinvel({x:12,y:20,z:-3},true);
    flight.controlledBody.setAngvel({x:0.3,y:-0.2,z:0.4},true);
    const poses=new Map(compiled.parts.map(p=>[p.id,flight.partPose(p.id)]));
    const momentum=scale(flight.controlledBody.linvel(),flight.controlledBody.mass());
    assert.equal(flight.stage(),1);assert.equal(flight.groups.length,2);
    assert.deepEqual(flight.controlledPartIds,['p1','p2','p3']);
    let after={...ZERO};
    for(const group of flight.groups)after=add(after,scale(group.body.linvel(),group.body.mass()));
    near(distance(momentum,after),0,0.04);
    for(const p of compiled.parts)near(distance(poses.get(p.id)!.position,flight.partPose(p.id).position),0,1e-5);
    assert.ok(flight.lit.has('p3'));assert.equal(flight.stage(),null);
    flight.step({throttle:1,turn:ZERO});assert.ok(flight.fuel.get('p2')!<700);
    assert.ok(flight.fuel.get('p5')!<2800);
  } finally {flight.dispose();}
});
check('imported custom craft flies; fuel exhaustion clips thrust and mass',()=>{
  let craft=addPart(freshCraft(),'tank-small','p1','bottom','top');
  craft=addPart(craft,'engine-small','p2','bottom','top');craft.parts[1]!.fuelKg=0.01;
  const flight=new AssemblyFlight(RAPIER,importCraft(exportCraft(craft)),0);
  try {
    flight.stage();flight.step({throttle:1,turn:ZERO});
    assert.equal(flight.fuel.get('p2'),0);
    assert.ok(flight.firing.get('p3')!>0&&flight.firing.get('p3')!<1);
    near(flight.controlledBody.mass(),500,0.001);
    const velocity={...flight.controlledBody.linvel()};
    flight.step({throttle:1,turn:ZERO});assert.equal(flight.firing.get('p3'),0);
    near(distance(velocity,flight.controlledBody.linvel()),0,1e-5);
  } finally {flight.dispose();}
});
check('unstaged actions and unconnected explosive nodes fail before launch',()=>{
  const unstaged=structuredClone(demo);unstaged.parts[2]!.stage=null;
  assert.throws(()=>new AssemblyFlight(RAPIER,unstaged),/assign a stage/);
  // Disconnect the authored top node while retaining an engine upstream.
  const invalid=addPart(addPart(freshCraft(),'engine-small','p1','bottom','top'),'decoupler','p2','bottom','bottom');
  assert.throws(()=>new AssemblyFlight(RAPIER,invalid),/not connected/);
});
console.log(`\n${checks} assembly checks passed.`);
