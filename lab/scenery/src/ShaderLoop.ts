import type { Node } from 'three/webgpu';
import { Loop } from 'three/tsl';

/** Three supports named loop indices at runtime; its declarations omit that option.
 * Distinct names are essential when an inner loop uses expressions from an outer loop.
 */
export function shaderLoop(name: string, end: Node<'int'> | number, body: (index: Node<'int'>) => void): void {
  const options = { name, start: 0, end, type: 'int' as const };
  Loop(options, inputs => body((inputs as unknown as Record<string, Node<'int'>>)[name]!));
}
