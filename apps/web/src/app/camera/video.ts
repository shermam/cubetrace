/**
 * Plays `stream` in `video`, muted (a preview never plays sound); the returned function lets go of
 * it, unless the element already plays another stream.
 */
export function showStream(video: HTMLVideoElement, stream: MediaStream): () => void {
  video.muted = true;
  video.srcObject = stream;
  const playing: unknown = video.play();
  if (playing instanceof Promise) {
    // A refusal (the stream replaced meanwhile) is dropped: the next one plays.
    playing.catch(() => undefined);
  }
  return () => {
    if (video.srcObject === stream) {
      video.srcObject = null;
    }
  };
}
