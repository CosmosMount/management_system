/** 当前环节被处理完成或进入下一环节时，重置停留与催办计时 */
export function stepTimerResetFields() {
  return {
    statusEnteredAt: new Date(),
    lastReminderAt: null,
  };
}
