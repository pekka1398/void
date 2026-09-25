import { FACE_ADJACENCY, FACE_EDGES } from './src/lod/FaceAdjacency';
import { CUBE_FACES } from './src/lod/TileKey';

const names = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;
console.log('face  edge  neighbor  neighbor edge  direction');
for (const face of CUBE_FACES) {
  for (const edge of FACE_EDGES) {
    const adjacent = FACE_ADJACENCY[face][edge];
    console.log(`${names[face].padEnd(5)} ${edge.padEnd(5)} ${names[adjacent.face].padEnd(9)} ${adjacent.edge.padEnd(14)} ${adjacent.reversed ? 'reversed' : 'same'}`);
  }
}
