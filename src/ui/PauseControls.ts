export type PauseControlsMode = 'flight' | 'onFoot';

export interface PauseControlRow {
  readonly id: string;
  readonly label: string;
  readonly keys: readonly string[];
  readonly detail?: string;
}

export interface PauseControlGroup {
  readonly title: string;
  readonly rows: readonly PauseControlRow[];
}

export interface PauseControlsSection {
  readonly id: PauseControlsMode;
  readonly label: string;
  readonly description: string;
  readonly groups: readonly PauseControlGroup[];
}

const SHARED_INTERFACE_CONTROLS: PauseControlGroup = {
  title: 'Interface',
  rows: [
    { id: 'pause', label: 'Pause / resume', keys: ['Esc'] },
    { id: 'settings', label: 'Graphics', keys: ['G'] },
    { id: 'map', label: 'System / galaxy chart', keys: ['M', 'Tab'] },
    { id: 'appearance', label: 'Cycle screen appearance', keys: ['N'] },
    { id: 'celestial-time', label: 'Celestial time slower / faster', keys: ['[ / ]'] },
  ],
};

/** Display copy for real, already-supported controls. This never dispatches game actions. */
export const PAUSE_CONTROLS: readonly PauseControlsSection[] = [
  {
    id: 'flight',
    label: 'Flight',
    description: 'The same controls work in chase and cockpit view.',
    groups: [
      {
        title: 'Handling',
        rows: [
          { id: 'pitch', label: 'Pitch up / down', keys: ['W / S', 'Z / S', '↑ / ↓'] },
          { id: 'yaw', label: 'Turn left / right', keys: ['A / D', '← / →'] },
          { id: 'roll', label: 'Roll left / right', keys: ['Q / E'] },
          { id: 'aim', label: 'Aim the ship', keys: ['Mouse drag'] },
          { id: 'thrust', label: 'Increase thrust', keys: ['Space'], detail: 'Release thrust to coast.' },
          { id: 'brake', label: 'Brake', keys: ['Ctrl'] },
          { id: 'throttle', label: 'Set persistent throttle', keys: ['Mouse wheel'] },
          { id: 'boost', label: 'Boost', keys: ['Shift'] },
          { id: 'vertical', label: 'Rise / descend', keys: ['F / C', 'PgUp / PgDn'], detail: 'Relative to the nearby planet.' },
          { id: 'view', label: 'Chase / cockpit view', keys: ['V'] },
        ],
      },
      {
        title: 'Navigation and surface',
        rows: [
          { id: 'inspect', label: 'Inspect a visible object', keys: ['Hover'] },
          { id: 'target', label: 'Select a waypoint', keys: ['Click'] },
          { id: 'approach', label: 'Approach selected destination', keys: ['P'], detail: 'Press again to cancel pulse travel.' },
          { id: 'hyperdrive', label: 'Interstellar hyperdrive', keys: ['H'] },
          { id: 'landing', label: 'Land / take off', keys: ['L'], detail: 'Press again to cancel an active landing or takeoff.' },
          { id: 'exit', label: 'Exit / board AURORA', keys: ['X'], detail: 'Press again to cancel an active exit or boarding.' },
          { id: 'orbit-reset', label: 'Return to starting orbit', keys: ['R'], detail: 'Keeps your discoveries.' },
        ],
      },
      SHARED_INTERFACE_CONTROLS,
    ],
  },
  {
    id: 'onFoot',
    label: 'On foot',
    description: 'Explore from the real boarding ramp. The ship stays where you parked it.',
    groups: [
      {
        title: 'Movement',
        rows: [
          { id: 'walk', label: 'Walk', keys: ['WASD', 'ZQSD', 'Arrow keys'] },
          { id: 'sprint', label: 'Sprint', keys: ['Shift'] },
          { id: 'look', label: 'Look around', keys: ['Mouse'], detail: 'Click the view to start mouse look.' },
          { id: 'drag-look', label: 'Look without mouse capture', keys: ['Left mouse + drag'] },
        ],
      },
      {
        title: 'Your ship',
        rows: [
          { id: 'board', label: 'Board at the aft ramp', keys: ['X'] },
          { id: 'cancel-boarding', label: 'Cancel exit / boarding', keys: ['X'] },
          { id: 'depart', label: 'Take off after boarding', keys: ['L'] },
        ],
      },
      SHARED_INTERFACE_CONTROLS,
    ],
  },
];

export function getPauseControls(mode: PauseControlsMode): PauseControlsSection {
  return PAUSE_CONTROLS.find((section) => section.id === mode)!;
}
