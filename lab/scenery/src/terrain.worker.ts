// Imports the worker host module directly: lab/lod's barrel also pulls in the renderer, which a worker does not need.
import { serveTileBuilds } from '../../lod/src/lod/TileWorkerHost';
import { layeredTerrain, type LayeredOptions } from './LayeredTerrain';

serveTileBuilds((options: LayeredOptions) => layeredTerrain(options));
