// Review toggle icons (24×24). Filled with currentColor so they follow the button's colour.
const icon = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;

export const openLeftSidebar = icon('M12.5,8v8l4-4l-4-4ZM5,21q-0.83,0-1.41-0.59T3,19V5Q3,4.17 3.59,3.59T5,3H19q0.83,0 1.41,0.59T21,5V19q0,0.82-0.59,1.41T19,21H5Zm3-2V5H5V19H8Zm2,0h9V5H10V19ZM8,19H5H8Z');
export const closeLeftSidebar = icon('M16.5,16V8l-4,4l4,4ZM5,21q-0.83,0-1.41-0.59T3,19V5Q3,4.17 3.59,3.59T5,3H19q0.83,0 1.41,0.59T21,5V19q0,0.82-0.59,1.41T19,21H5Zm3-2V5H5V19H8Zm2,0h9V5H10V19ZM8,19H5H8Z');
