// Adapted from minmax in pseudosavant/player.html, src/js/utils.js.
// Copyright (c) 2021 Paul Ellis. MIT license in third-party/player.html-LICENSE.
export const clamp = (minimum, value, maximum) => Math.max(minimum, Math.min(maximum, value));
