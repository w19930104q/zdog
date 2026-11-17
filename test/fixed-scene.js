/* eslint-env node */
/**
 * Fixed scene for zdog render regression tests.
 * Covers: zero-depth shapes (equal sort values), nested rotate/translate
 * chains, extreme & non-finite coordinates (near-plane clipping),
 * empty & populated groups, and a single-point canvas dot.
 * The scene is deterministic: building it twice yields identical frames.
 */

var Zdog = require('../js/index.js');

var TAU = Zdog.TAU;

function buildScene() {
  var root = new Zdog.Anchor();
  var items = {};

  function label( item, name ) {
    item.testLabel = name;
    items[ name ] = item;
    return item;
  }

  // ----- zero-depth plane: all sort values equal 0 ----- //
  // render order must follow creation order on every engine
  label( new Zdog.Rect({
    addTo: root,
    width: 40,
    height: 30,
    translate: { x: -50, y: -50 },
    stroke: 4,
    fill: true,
    color: '#E62',
  }), 'zeroA' );

  label( new Zdog.Ellipse({
    addTo: root,
    diameter: 36,
    translate: { x: 0, y: -50 },
    stroke: 4,
    fill: true,
    color: '#636',
  }), 'zeroB' );

  label( new Zdog.Polygon({
    addTo: root,
    sides: 3,
    radius: 20,
    translate: { x: 50, y: -50 },
    stroke: 4,
    fill: true,
    color: '#EA0',
  }), 'zeroC' );

  // ----- nested rotate/translate chain, three levels deep ----- //
  var nestA = label( new Zdog.Anchor({
    addTo: root,
    translate: { y: 10 },
    rotate: { z: TAU/16 },
  }), 'nestA' );

  var nestB = label( new Zdog.Anchor({
    addTo: nestA,
    translate: { x: -40 },
    rotate: { x: TAU/10 },
  }), 'nestB' );

  var nestC = label( new Zdog.Anchor({
    addTo: nestB,
    translate: { z: 20 },
    rotate: { y: TAU/8 },
  }), 'nestC' );

  label( new Zdog.Rect({
    addTo: nestC,
    width: 20,
    height: 14,
    stroke: 3,
    fill: true,
    color: '#19C',
  }), 'nested' );

  // ----- single-point shape, renders as canvas dot ----- //
  label( new Zdog.Shape({
    addTo: root,
    translate: { x: 60, y: 35 },
    stroke: 10,
    color: '#0AA',
  }), 'dot' );

  // ----- groups ----- //
  // empty group: 0/0 sort value must not corrupt the sort
  label( new Zdog.Group({
    addTo: root,
  }), 'emptyGroup' );

  var group = label( new Zdog.Group({
    addTo: root,
    translate: { y: 55 },
  }), 'group' );

  label( new Zdog.Rect({
    addTo: group,
    width: 30,
    height: 16,
    translate: { x: -30 },
    stroke: 3,
    color: '#333',
  }), 'groupRectA' );

  label( new Zdog.Rect({
    addTo: group,
    width: 16,
    height: 30,
    translate: { x: 30 },
    rotate: { z: TAU/8 },
    stroke: 3,
    color: '#930',
  }), 'groupRectB' );

  // clipped dot inside a rendered group: group survives, child is clipped
  label( new Zdog.Shape({
    addTo: group,
    translate: { z: 3e9 },
    stroke: 4,
  }), 'groupFarDot' );

  // ----- near-plane / extreme coordinate cases ----- //
  // coordinate overflows to Infinity (1e308 * 10 > Number.MAX_VALUE)
  label( new Zdog.Rect({
    addTo: root,
    width: 20,
    height: 20,
    translate: { x: 1e308 * 10, y: 0 },
    stroke: 2,
    color: '#F00',
  }), 'overflow' );

  // nested +Infinity/-Infinity translates cancel to NaN
  var nanParent = label( new Zdog.Anchor({
    addTo: root,
    translate: { x: 1e308 * 10 },
  }), 'nanParent' );

  label( new Zdog.Shape({
    addTo: nanParent,
    path: [
      { x: -10, y: -10 },
      { x: 10, y: 10 },
    ],
    translate: { x: -1e308 * 10 },
    stroke: 2,
    color: '#F0A',
  }), 'nanShape' );

  // finite but beyond the maxCoordinate guard band
  label( new Zdog.Shape({
    addTo: root,
    translate: { x: 2e9, y: 0 },
    stroke: 6,
  }), 'farAway' );

  return {
    root: root,
    items: items,
  };
}

// mutate the scene per frame index, simulating camera motion
// frame 0: initial state
// frame 1: rotate the graph, push extreme items further out
// frame 2: bring extreme items back into range — the frame after a
//          clipped frame must render correctly (no NaN carry-over)
function applyFrame( scene, frameIndex ) {
  var items = scene.items;
  if ( frameIndex == 1 ) {
    scene.root.rotate.y = TAU/32;
    scene.root.rotate.x = -TAU/48;
    items.overflow.translate.x = -1e308 * 10;
    items.farAway.translate.x = 3e9;
  } else if ( frameIndex == 2 ) {
    items.overflow.translate.set({ x: 80, y: 55, z: 0 });
    items.nanParent.translate.set({ x: 0, y: 0, z: 0 });
    items.nanShape.translate.set({ x: 0, y: 0, z: 0 });
  }
}

module.exports = {
  buildScene: buildScene,
  applyFrame: applyFrame,
  FRAME_COUNT: 3,
};
