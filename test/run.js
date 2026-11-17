/* eslint-env node */
/**
 * Fixed-scene render test for zdog.
 * Runs the fixed scene for three frames, exports frame elements, bounds
 * and pixel hashes to test/output/frame-report.json, and asserts:
 *  - no NaN/Infinity leaks into elements, bounds, or sort values
 *  - near-plane clipped items are not rendered but do not poison the frame
 *  - zero-depth items render in stable creation order
 *  - the frame after a clipped frame renders correctly
 *  - rendering is deterministic across independent scene builds
 *  - chainable API is preserved
 */

var fs = require('fs');
var path = require('path');
var Zdog = require('../js/index.js');
var harness = require('./harness.js');
var fixedScene = require('./fixed-scene.js');

harness.installMockDocument();

var failures = [];

function check( condition, message ) {
  if ( condition ) {
    console.log( '  ok - ' + message );
  } else {
    failures.push( message );
    console.log( '  FAIL - ' + message );
  }
}

// ----- run the fixed scene, export frames ----- //

function runScene() {
  var scene = fixedScene.buildScene();
  var frames = [];
  for ( var frameIndex = 0; frameIndex < fixedScene.FRAME_COUNT; frameIndex++ ) {
    fixedScene.applyFrame( scene, frameIndex );
    scene.root.updateGraph();
    // render to mock svg & mock canvas
    var svg = harness.createMockSvg();
    scene.root.renderGraphSvg( svg );
    var ctx = harness.createMockContext();
    scene.root.renderGraphCanvas( ctx );
    // export frame elements with labels
    var elements = svg.children.map( function( elem ) {
      return {
        label: getLabelForElement( scene, elem ),
        path: elem.attributes.d,
        stroke: elem.attributes.stroke,
        strokeWidth: elem.attributes['stroke-width'],
        fill: elem.attributes.fill,
      };
    } );
    var clipped = harness.collectItems( scene.root, [] )
      .filter( function( item ) {
          return item.isClipped;
        } )
      .map( function( item ) {
          return item.testLabel || '(root)';
        } );
    frames.push({
      index: frameIndex,
      elements: elements,
      bounds: harness.getFrameBounds( scene.root ),
      clipped: clipped,
      canvasOpCount: ctx.ops.length,
      pixelHash: harness.getPixelHash( ctx.ops, harness.CANVAS_SIZE,
          harness.CANVAS_SIZE ),
      elementHash: harness.hashString( JSON.stringify( elements ) ),
    });
  }
  return {
    scene: scene,
    frames: frames,
  };
}

function getLabelForElement( scene, elem ) {
  var label = null;
  Object.keys( scene.items ).forEach( function( name ) {
    if ( scene.items[ name ].svgElement === elem ) {
      label = name;
    }
  } );
  return label;
}

// ----- checks ----- //

console.log('running fixed scene (two independent builds)...');
var runA = runScene();
var runB = runScene();
var sceneA = runA.scene;
var framesA = runA.frames;
var framesB = runB.frames;

console.log('determinism:');
var hashesA = framesA.map( function( frame ) {
  return frame.pixelHash + ' ' + frame.elementHash;
} );
var hashesB = framesB.map( function( frame ) {
  return frame.pixelHash + ' ' + frame.elementHash;
} );
check( JSON.stringify( hashesA ) == JSON.stringify( hashesB ),
    'pixel & element hashes identical across independent scene builds' );

console.log('no NaN/Infinity leakage:');
var reportJson = JSON.stringify( framesA );
check( !( /NaN|Infinity/ ).test( reportJson ),
    'no NaN/Infinity in exported elements, bounds, or hashes' );
framesA.forEach( function( frame ) {
  check( frame.bounds !== null &&
      isFinite( frame.bounds.minX ) && isFinite( frame.bounds.minY ) &&
      isFinite( frame.bounds.maxX ) && isFinite( frame.bounds.maxY ),
  'frame ' + frame.index + ' bounds are finite' );
} );

console.log('near-plane clipping:');
var items = sceneA.items;
var clippedLabels = [ 'overflow', 'nanShape', 'farAway', 'groupFarDot' ];
var frames01Labels = framesA[0].elements.concat( framesA[1].elements )
  .map( function( elem ) {
      return elem.label;
    } );
check( clippedLabels.every( function( name ) {
  return frames01Labels.indexOf( name ) == -1;
} ), 'extreme/non-finite items are not rendered in frames 0-1' );
check( !items.farAway.svgElement && !items.groupFarDot.svgElement,
    'permanently clipped items never create render elements' );
check( framesA[0].clipped.indexOf('overflow') != -1 &&
    framesA[0].clipped.indexOf('nanShape') != -1 &&
    framesA[0].clipped.indexOf('farAway') != -1 &&
    framesA[0].clipped.indexOf('groupFarDot') != -1,
'frame 0 clips overflow, nanShape, farAway, groupFarDot' );
check( framesA[0].clipped.indexOf('emptyGroup') != -1,
    'empty group gets a defined (clipped) sort value instead of NaN' );
check( sceneA.items.emptyGroup.sortValue === Infinity,
    'empty group sortValue is Infinity, not NaN' );

console.log('recovery after clipped frames:');
check( !!items.overflow.svgElement && !!items.nanShape.svgElement,
    'frame 2 renders previously clipped items brought back in range' );
var frame2Labels = framesA[2].elements.map( function( elem ) {
  return elem.label;
} );
check( frame2Labels.indexOf('overflow') != -1 &&
    frame2Labels.indexOf('nanShape') != -1,
'frame 2 element list includes recovered items' );
check( framesA[2].clipped.indexOf('overflow') == -1 &&
    framesA[2].clipped.indexOf('nanShape') == -1,
'frame 2 no longer clips recovered items' );

console.log('zero-depth sort stability:');
var frame0Children = [];
// re-derive svg child order from element labels of frame 0
framesA[0].elements.forEach( function( elem ) {
  frame0Children.push( elem.label );
} );
check( frame0Children.indexOf('zeroA') < frame0Children.indexOf('zeroB') &&
    frame0Children.indexOf('zeroB') < frame0Children.indexOf('zeroC'),
'zero-depth items render in creation order' );
var sorter = Zdog.Anchor.shapeSorter;
var itemX = { sortValue: 0, id: 1 };
var itemY = { sortValue: 0, id: 2 };
var itemClipped = { sortValue: Infinity, id: 0 };
check( sorter( itemX, itemY ) < 0 && sorter( itemY, itemX ) > 0,
    'shapeSorter breaks zero-depth ties by creation id' );
check( sorter( itemClipped, itemX ) > 0 && sorter( itemX, itemClipped ) < 0,
    'shapeSorter places clipped (non-finite) items last' );
check( sorter( itemClipped, { sortValue: NaN, id: 5 } ) < 0,
    'shapeSorter orders clipped items among themselves by id' );

console.log('pixel hash sensitivity:');
check( framesA[0].pixelHash != framesA[1].pixelHash,
    'rotating the graph changes the pixel hash' );

console.log('chainable API:');
var vec = new Zdog.Vector();
var chained = vec.set({ x: 1, y: 2, z: 3 })
  .add({ x: 1 })
  .subtract({ z: 1 })
  .multiply( 2 )
  .rotate({ z: 0.25 })
  .transform( { x: 1 }, { y: 0.1 }, 1 )
  .lerp( { x: 0, y: 0, z: 0 }, 0.5 );
check( chained === vec, 'Vector methods return this' );
check( isFinite( vec.x ) && isFinite( vec.y ) && isFinite( vec.z ),
    'chained vector math stays finite' );

console.log('anchor inheritance:');
checkNoDuplicates( Zdog.Shape.optionKeys, 'Shape' );
checkNoDuplicates( Zdog.Ellipse.optionKeys, 'Ellipse' );
checkNoDuplicates( Zdog.Box.optionKeys, 'Box' );
check( Zdog.Ellipse.optionKeys.indexOf('quarters') != -1 &&
    Zdog.Ellipse.optionKeys.indexOf('stroke') != -1,
'subclass optionKeys inherit parent keys exactly once' );

function checkNoDuplicates( keys, name ) {
  var seen = {};
  var hasDuplicate = false;
  keys.forEach( function( key ) {
    if ( seen[ key ] ) {
      hasDuplicate = true;
    }
    seen[ key ] = true;
  } );
  check( !hasDuplicate, name + '.optionKeys has no duplicate keys' );
}

// ----- export report ----- //

var report = {
  scene: 'zdog fixed scene v1',
  canvasSize: harness.CANVAS_SIZE,
  frames: framesA,
};
var outputDir = path.join( __dirname, 'output' );
if ( !fs.existsSync( outputDir ) ) {
  fs.mkdirSync( outputDir, { recursive: true } );
}
var reportPath = path.join( outputDir, 'frame-report.json' );
fs.writeFileSync( reportPath, JSON.stringify( report, null, 2 ) + '\n' );
console.log( '\nframe report written to ' + reportPath );
framesA.forEach( function( frame ) {
  console.log( '  frame ' + frame.index + ': ' +
    frame.elements.length + ' elements, ' +
    frame.canvasOpCount + ' canvas ops, ' +
    'clipped=[' + frame.clipped.join(',') + '], ' +
    'pixelHash=' + frame.pixelHash.slice( 0, 12 ) + '...' );
} );

if ( failures.length ) {
  console.log( '\n' + failures.length + ' check(s) FAILED' );
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
