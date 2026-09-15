import { Pipe, PipeTransform } from '@angular/core';

/** Spans carry nanoseconds; people read milliseconds and seconds. */
@Pipe({ name: 'duration' })
export class DurationPipe implements PipeTransform {
  transform(nanoseconds: number): string {
    if (!Number.isFinite(nanoseconds) || nanoseconds < 0) {
      return '—';
    }

    const ms = nanoseconds / 1e6;

    if (ms < 1) {
      return `${(nanoseconds / 1e3).toFixed(0)} µs`;
    }

    if (ms < 1000) {
      return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
    }

    return `${(ms / 1000).toFixed(2)} s`;
  }
}
