import type { Player } from './adapters/types';

export class Html5Player implements Player {
  constructor(readonly video: HTMLVideoElement) {}

  currentMs(): number {
    return this.video.currentTime * 1000;
  }

  seek(ms: number): void {
    this.video.currentTime = Math.max(0, ms) / 1000;
  }

  play(): void {
    void this.video.play();
  }

  pause(): void {
    this.video.pause();
  }

  isPaused(): boolean {
    return this.video.paused;
  }

  setRate(rate: number): void {
    this.video.playbackRate = rate;
  }

  rate(): number {
    return this.video.playbackRate;
  }
}
