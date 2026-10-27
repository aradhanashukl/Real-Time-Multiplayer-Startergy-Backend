function movePlayer(player, dx, dy) {
  // TODO 1: if dx or dy is not -1, 0, or 1, return player unchanged
  if (dx !== -1 && dx !== 0 && dx !== 1) {
    return player;
  }
  if (dy !== -1 && dy !== 0 && dy !== 1) {
    return player;
  }
  // TODO 2: if dx and dy are both 0, return player unchanged (that's not a move)
  if (dx === 0 && dy === 0) {
    return player;
  }
  // TODO 3: work out newX = player.x + dx and newY = player.y + dy
  const newX = player.x + dx;
  const newY = player.y + dy;
  // TODO 4: if newX or newY is outside 0..9, return player unchanged
  if (newX < 0 || newX > 9 || newY < 0 || newY > 9) {
    return player;
  }
  // TODO 5: otherwise return a NEW player with x and y updated
  return { ...player, x: newX, y: newY };
}

function movePlayerInState(state, playerId, dx, dy) {
  
  const player = state.players[playerId];
  if (player === undefined) {
    return state;
  }

  const movedPlayer = movePlayer(player, dx, dy);
  if (movedPlayer === player) {
    return state;
  }

  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: movedPlayer,
    },
  };
}
function attackPlayer(state, attackerId, targetId) {
  const attacker = state.players[attackerId];
  const target = state.players[targetId];
  if(attacker === undefined || target === undefined) {
    return state;
  }
  if(attackerId === targetId) {
    return state;
  }
  if(attacker.hp <= 0 || target.hp <= 0) {
    return state;
  }
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    return state;
  }

  // Rule 5: valid attack, target loses 10 hp (never below 0)
  const hurtTarget = { ...target, hp: Math.max(0, target.hp - 10) };
  return {
    ...state,
    players: {
      ...state.players,
      [targetId]: hurtTarget,
    },
  };


}
function applyAction(state, action) {
  if (action.type === 'MOVE') {
    return movePlayerInState(state, action.playerId, action.dx, action.dy);
  }
  if (action.type === 'ATTACK') {
    return attackPlayer(state, action.attackerId, action.targetId);
  }
  return state; // unknown action type: ignore it
}

function replay(initialState, actions) {
  let state = initialState;
  for (const action of actions) {
    state = applyAction(state, action);
  }
  return state;
}
module.exports = { movePlayer, movePlayerInState, attackPlayer, applyAction, replay };