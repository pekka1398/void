import { buildTerrainTileBuffers, terrainTileTransferList } from '../Geometry';
import { buildContactSurfaceGeneration } from '../ContactGeometry';
import { buildSurfacePatchGeometryBuffers, surfacePatchTransferables } from '../SurfacePatchGeometry';
import { buildPlanetProxyGeometryBuffers, planetProxyTransferables } from '../PlanetProxyGeometry';
import { buildSurfaceSceneryBuffers, surfaceSceneryTransferList } from '../SurfaceScenery';
import type { SharedTerrainWorkerRequest, SharedTerrainWorkerResponse } from '../TerrainJobScheduler';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<SharedTerrainWorkerRequest>) => void) | null;
  postMessage: (message: SharedTerrainWorkerResponse, transfer: Transferable[]) => void;
};

workerScope.onmessage = (event: MessageEvent<SharedTerrainWorkerRequest>): void => {
  const request = event.data;
  if (request.kind === 'contact') {
    const generation = buildContactSurfaceGeneration(request.field, request.lease, request.options);
    workerScope.postMessage({ kind: 'contact', jobId: request.jobId, generation }, [
      generation.vertices.buffer, generation.colors.buffer, generation.indices.buffer,
    ]);
    return;
  }
  if (request.kind === 'surface-patch') {
    const buffers = buildSurfacePatchGeometryBuffers(request.field, request.options);
    workerScope.postMessage({ kind: 'surface-patch', jobId: request.jobId,
      key: request.key, token: request.token, buffers }, surfacePatchTransferables(buffers));
    return;
  }
  if (request.kind === 'planet-proxy') {
    const buffers = buildPlanetProxyGeometryBuffers(request.field, request.options);
    workerScope.postMessage({ kind: 'planet-proxy', jobId: request.jobId,
      key: request.key, token: request.token, buffers }, planetProxyTransferables(buffers));
    return;
  }
  if (request.kind === 'surface-scenery') {
    const buffers = buildSurfaceSceneryBuffers(request.field, request.options);
    workerScope.postMessage({ kind: 'surface-scenery', jobId: request.jobId,
      key: request.key, token: request.token, buffers }, surfaceSceneryTransferList(buffers));
    return;
  }
  const { field, key, options, token } = request;
  const buffers = buildTerrainTileBuffers(field, key, options);
  const response: SharedTerrainWorkerResponse = { kind: 'terrain', jobId: request.jobId, key, token, buffers };
  workerScope.postMessage(response, terrainTileTransferList(buffers));
};
