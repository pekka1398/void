/**
 * The view lab's single view: the camera that turns from the flight view into
 * the map as it zooms out, and the map layer. Changes they need are made in
 * lab/view, whose checks must keep passing.
 */
export {
  OrbitCamera, viewState, MAP_FADE_RADII, SURFACE_LOCK_RADII, type FocusGeometry, type ViewState,
} from '../../view/src/ViewCamera';
export { MapLayer, toThree, type Focus, type VesselPath } from '../../view/src/MapLayer';
