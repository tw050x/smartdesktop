// Where the chat's own window sits relative to the app window it belongs to: measured from the
// nearer of its sides and of its top and bottom, so resizing the app window from any edge keeps the
// chat where it was beside that edge, inside the window or out of it. (Moving the app window moves
// the chat with it by itself: it's a child window.)

export function anchorOf(parent, child) {
  const right = child.x + child.width / 2 > parent.x + parent.width / 2;
  const bottom = child.y + child.height / 2 > parent.y + parent.height / 2;
  return {
    side: right ? 'right' : 'left',
    dx: right ? child.x - (parent.x + parent.width) : child.x - parent.x,
    edge: bottom ? 'bottom' : 'top',
    dy: bottom ? child.y - (parent.y + parent.height) : child.y - parent.y,
  };
}

export function placeFrom(parent, anchor, size) {
  return {
    x: Math.round(anchor.side === 'right' ? parent.x + parent.width + anchor.dx : parent.x + anchor.dx),
    y: Math.round(anchor.edge === 'bottom' ? parent.y + parent.height + anchor.dy : parent.y + anchor.dy),
    width: size.width,
    height: size.height,
  };
}

// Where it first opens: inside the window's right edge, below its top bar.
export function firstPlace(parent, { width = 400, top = 64 } = {}) {
  const height = Math.max(320, Math.min(680, parent.height - top - 24));
  return { x: parent.x + parent.width - width - 24, y: parent.y + top, width, height };
}
