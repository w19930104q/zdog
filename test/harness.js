/* eslint-env node, es6 */
/**
 * Test harness for zdog render tests.
 * Provides a mock canvas 2d context with a deterministic software
 * rasterizer (for real pixel hashes), mock SVG elements (for frame
 * element export), and frame bounds exporters. No DOM required.
 */

var crypto = require('crypto');

var CANVAS_SIZE = 160;
var BEZIER_SEGMENTS = 16;

// ----- hash ----- //

function hashString( str ) {
  return crypto.createHash('sha256')
    .update( str )
    .digest('hex');
}

function hashBuffer( buffer ) {
  return crypto.createHash('sha256')
    .update( buffer )
    .digest('hex');
}

// ----- mock canvas 2d context ----- //
// records drawing ops with styles resolved at record time,
// so the op stream can be rasterized deterministically afterwards

function createMockContext() {
  var ctx = {
    ops: [],
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'round',
    lineJoin: 'round',
  };
  ctx.beginPath = function() {
    ctx.ops.push({ op: 'beginPath' });
  };
  ctx.moveTo = function( pointX, pointY ) {
    ctx.ops.push({ op: 'moveTo', x: pointX, y: pointY });
  };
  ctx.lineTo = function( pointX, pointY ) {
    ctx.ops.push({ op: 'lineTo', x: pointX, y: pointY });
  };
  // matches the 6-argument canvas signature
  ctx.bezierCurveTo = function() {
    ctx.ops.push({
      op: 'bezierCurveTo',
      cp0x: arguments[0], cp0y: arguments[1],
      cp1x: arguments[2], cp1y: arguments[3],
      x: arguments[4], y: arguments[5],
    });
  };
  ctx.closePath = function() {
    ctx.ops.push({ op: 'closePath' });
  };
  ctx.arc = function( pointX, pointY, radius ) {
    ctx.ops.push({
      op: 'arc',
      x: pointX, y: pointY, radius: radius,
      color: ctx.fillStyle,
    });
  };
  ctx.fill = function() {
    ctx.ops.push({ op: 'fill', color: ctx.fillStyle });
  };
  ctx.stroke = function() {
    ctx.ops.push({
      op: 'stroke',
      color: ctx.strokeStyle,
      lineWidth: ctx.lineWidth,
    });
  };
  return ctx;
}

// ----- software rasterizer ----- //

function parseColor( color ) {
  var hex = color.charAt( 0 ) == '#' ? color.slice( 1 ) : color;
  if ( hex.length == 3 ) {
    hex = hex.charAt( 0 ) + hex.charAt( 0 ) + hex.charAt( 1 ) +
      hex.charAt( 1 ) + hex.charAt( 2 ) + hex.charAt( 2 );
  }
  return [
    parseInt( hex.slice( 0, 2 ), 16 ),
    parseInt( hex.slice( 2, 4 ), 16 ),
    parseInt( hex.slice( 4, 6 ), 16 ),
  ];
}

function cubicPoint( p0, p1, p2, p3, alpha ) {
  var beta = 1 - alpha;
  var w0 = beta * beta * beta;
  var w1 = 3 * beta * beta * alpha;
  var w2 = 3 * beta * alpha * alpha;
  var w3 = alpha * alpha * alpha;
  return [
    w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
    w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
  ];
}

// rasterizes recorded canvas ops to an RGBA pixel buffer,
// scene origin centered like Illustration's `centered` option
function Rasterizer( width, height ) {
  this.width = width;
  this.height = height;
  this.offsetX = width/2;
  this.offsetY = height/2;
  this.pixels = new Uint8Array( width * height * 4 );
  for ( var i = 0; i < this.pixels.length; i++ ) {
    this.pixels[i] = 255;
  }
  // path state
  this.subpaths = [];
  this.currentSubpath = null;
  this.currentPoint = null;
}

Rasterizer.prototype.setPixel = function( px, py, color ) {
  px = Math.round( px );
  py = Math.round( py );
  if ( px < 0 || px >= this.width || py < 0 || py >= this.height ) {
    return;
  }
  var index = ( py * this.width + px ) * 4;
  this.pixels[ index ] = color[0];
  this.pixels[ index + 1 ] = color[1];
  this.pixels[ index + 2 ] = color[2];
  this.pixels[ index + 3 ] = 255;
};

Rasterizer.prototype.stampDisc = function( centerX, centerY, radius, color ) {
  var minX = Math.floor( centerX - radius );
  var maxX = Math.ceil( centerX + radius );
  var minY = Math.floor( centerY - radius );
  var maxY = Math.ceil( centerY + radius );
  for ( var py = minY; py <= maxY; py++ ) {
    for ( var px = minX; px <= maxX; px++ ) {
      var deltaX = px - centerX;
      var deltaY = py - centerY;
      if ( deltaX * deltaX + deltaY * deltaY <= radius * radius ) {
        this.setPixel( px, py, color );
      }
    }
  }
};

Rasterizer.prototype.drawSegment = function( start, end, radius, color ) {
  var deltaX = end[0] - start[0];
  var deltaY = end[1] - start[1];
  var length = Math.sqrt( deltaX * deltaX + deltaY * deltaY );
  var steps = Math.max( 1, Math.ceil( length * 2 ) );
  for ( var i = 0; i <= steps; i++ ) {
    var alpha = i/steps;
    this.stampDisc( start[0] + deltaX * alpha, start[1] + deltaY * alpha,
        radius, color );
  }
};

// even-odd scanline fill over all subpaths
Rasterizer.prototype.fillSubpaths = function( color ) {
  for ( var py = 0; py < this.height; py++ ) {
    var sceneY = py - this.offsetY + 0.5;
    var intersections = [];
    for ( var sub = 0; sub < this.subpaths.length; sub++ ) {
      var points = this.subpaths[ sub ];
      for ( var i = 0; i < points.length - 1; i++ ) {
        var y0 = points[i][1];
        var y1 = points[ i + 1 ][1];
        if ( ( y0 <= sceneY ) != ( y1 <= sceneY ) ) {
          var x0 = points[i][0];
          var x1 = points[ i + 1 ][0];
          intersections.push( x0 + ( sceneY - y0 ) * ( x1 - x0 ) / ( y1 - y0 ) );
        }
      }
    }
    intersections.sort( sortNumbers );
    for ( var pair = 0; pair + 1 < intersections.length; pair += 2 ) {
      var minPx = Math.ceil( intersections[ pair ] + this.offsetX - 0.5 );
      var maxPx = Math.ceil( intersections[ pair + 1 ] + this.offsetX - 0.5 ) - 1;
      for ( var px = minPx; px <= maxPx; px++ ) {
        this.setPixel( px, py, color );
      }
    }
  }
};

function sortNumbers( a, b ) {
  return a - b;
}

// ----- op handlers ----- //

Rasterizer.prototype.applyMove = function( op ) {
  this.currentSubpath = [ [ op.x, op.y ] ];
  this.subpaths.push( this.currentSubpath );
  this.currentPoint = [ op.x, op.y ];
};

Rasterizer.prototype.applyLine = function( op ) {
  if ( !this.currentSubpath ) {
    this.currentSubpath = [ this.currentPoint || [ 0, 0 ] ];
    this.subpaths.push( this.currentSubpath );
  }
  this.currentSubpath.push([ op.x, op.y ]);
  this.currentPoint = [ op.x, op.y ];
};

Rasterizer.prototype.applyBezier = function( op ) {
  var origin = this.currentPoint || [ 0, 0 ];
  for ( var step = 1; step <= BEZIER_SEGMENTS; step++ ) {
    var alpha = step/BEZIER_SEGMENTS;
    this.currentSubpath.push( cubicPoint( origin,
        [ op.cp0x, op.cp0y ], [ op.cp1x, op.cp1y ], [ op.x, op.y ],
        alpha ) );
  }
  this.currentPoint = [ op.x, op.y ];
};

Rasterizer.prototype.applyClose = function() {
  if ( this.currentSubpath && this.currentSubpath.length > 1 ) {
    this.currentSubpath.push( this.currentSubpath[0] );
    this.currentPoint = this.currentSubpath[0];
  }
};

Rasterizer.prototype.applyArc = function( op ) {
  this.stampDisc( op.x + this.offsetX, op.y + this.offsetY,
      op.radius, parseColor( op.color ) );
};

Rasterizer.prototype.applyStroke = function( op ) {
  var color = parseColor( op.color );
  var radius = op.lineWidth / 2;
  for ( var sub = 0; sub < this.subpaths.length; sub++ ) {
    var points = this.subpaths[ sub ];
    for ( var i = 0; i < points.length - 1; i++ ) {
      this.drawSegment(
          [ points[i][0] + this.offsetX, points[i][1] + this.offsetY ],
          [ points[ i + 1 ][0] + this.offsetX, points[ i + 1 ][1] + this.offsetY ],
          radius, color
      );
    }
  }
};

Rasterizer.prototype.applyOp = function( op ) {
  if ( op.op == 'beginPath' ) {
    this.subpaths = [];
    this.currentSubpath = null;
  } else if ( op.op == 'moveTo' ) {
    this.applyMove( op );
  } else if ( op.op == 'lineTo' ) {
    this.applyLine( op );
  } else if ( op.op == 'bezierCurveTo' ) {
    this.applyBezier( op );
  } else if ( op.op == 'closePath' ) {
    this.applyClose();
  } else if ( op.op == 'arc' ) {
    this.applyArc( op );
  } else if ( op.op == 'stroke' ) {
    this.applyStroke( op );
  } else if ( op.op == 'fill' ) {
    this.fillSubpaths( parseColor( op.color ) );
  }
};

Rasterizer.prototype.rasterize = function( ops ) {
  ops.forEach( this.applyOp, this );
  return this.pixels;
};

function getPixelHash( ops, width, height ) {
  var rasterizer = new Rasterizer( width, height );
  var pixels = rasterizer.rasterize( ops );
  return hashBuffer( Buffer.from( pixels ) );
}

// ----- mock svg ----- //

function MockSvgElement( tagName ) {
  this.tagName = tagName;
  this.attributes = {};
  this.children = [];
}

MockSvgElement.prototype.setAttribute = function( name, value ) {
  this.attributes[ name ] = String( value );
};

MockSvgElement.prototype.appendChild = function( child ) {
  this.children.push( child );
};

function createMockSvg() {
  return new MockSvgElement('svg');
}

// zdog's Shape.getRenderElement uses the global document
function installMockDocument() {
  global.document = {
    createElementNS: function( namespaceURI, tagName ) {
      return new MockSvgElement( tagName );
    },
  };
}

// ----- frame exporters ----- //

// collect self & all descendants, ignoring Group flatGraph semantics
function collectItems( item, list ) {
  list.push( item );
  item.children.forEach( function( child ) {
    collectItems( child, list );
  } );
  return list;
}

function round3( num ) {
  return Math.round( num * 1000 ) / 1000;
}

// bounds over rendered geometry of visible, non-clipped shapes
function getFrameBounds( root ) {
  var items = collectItems( root, [] );
  var minX = Infinity;
  var minY = Infinity;
  var maxX = -Infinity;
  var maxY = -Infinity;
  items.forEach( function( item ) {
    if ( !item.pathCommands || item.isClipped || !item.visible ) {
      return;
    }
    item.pathCommands.forEach( function( command ) {
      command.renderPoints.forEach( function( point ) {
        minX = Math.min( minX, point.x );
        minY = Math.min( minY, point.y );
        maxX = Math.max( maxX, point.x );
        maxY = Math.max( maxY, point.y );
      } );
    } );
  } );
  if ( minX == Infinity ) {
    return null;
  }
  return {
    minX: round3( minX ),
    minY: round3( minY ),
    maxX: round3( maxX ),
    maxY: round3( maxY ),
  };
}

module.exports = {
  CANVAS_SIZE: CANVAS_SIZE,
  hashString: hashString,
  createMockContext: createMockContext,
  getPixelHash: getPixelHash,
  createMockSvg: createMockSvg,
  installMockDocument: installMockDocument,
  collectItems: collectItems,
  getFrameBounds: getFrameBounds,
};
