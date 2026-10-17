export function frameScrollAction({ cardId, frame, scroll, pollMilliseconds = 30 }) {
  if (!Number.isSafeInteger(cardId) || cardId < 1 || !Number.isSafeInteger(frame) || frame < 0
    || !Number.isSafeInteger(scroll?.x) || scroll.x < 0 || !Number.isSafeInteger(scroll?.y) || scroll.y < 0
    || !Number.isSafeInteger(pollMilliseconds) || pollMilliseconds <= 0) {
    throw new Error('Native frame/scroll action requires a card, frame, and nonnegative integer scroll coordinates.');
  }
  return `(async()=>{
    const api=window.miNoteCaptureComparison;
    if(!api)throw new Error('Capture tab changed');
    const checkApi=()=>{if(window.miNoteCaptureComparison!==api)throw new Error('Capture tab changed');};
    let pose=await api.setFrame(${frame});
    for(;;){
      checkApi();
      if(pose?.error||pose?.asyncError)throw new Error(pose.error||pose.asyncError);
      if(pose?.ready&&pose.paintReady&&pose.cardId===${cardId}&&pose.frame===${frame}&&pose.nativePixels===true&&pose.viewport?.visibility==='visible')break;
      await new Promise(resolve=>setTimeout(resolve,${pollMilliseconds}));
      checkApi();
      pose=api.snapshot();
    }
    const scrolled=await api.setScrollPixels(${scroll.x},${scroll.y});
    checkApi();
    return {pose,scrolled};
  })()`;
}
