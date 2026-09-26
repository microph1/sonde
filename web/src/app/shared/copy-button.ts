import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { Subject, map, startWith, switchMap, timer } from 'rxjs';

/**
 * Copy one value, and say so.
 *
 * The acknowledgement is the whole point: a clipboard write is invisible, and
 * without feedback the only way to find out whether it worked is to paste
 * somewhere and look. The label reverts after a moment so the button is never
 * left claiming something about a copy made minutes ago.
 */
@Component({
  selector: 'wt-copy',
  imports: [AsyncPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      [class.done]="copied$ | async"
      [attr.aria-label]="label"
      [title]="title || label"
      (click)="copy()"
    >
      @if (copied$ | async) {
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7-7" /></svg>
      } @else {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" />
        </svg>
      }

      @if (text) {
        <span>{{ (copied$ | async) ? 'Copied' : text }}</span>
      }
    </button>
  `,
  styles: `
    button {
      display: inline-flex;
      align-items: center;
      gap: var(--fx-3xs);
      padding: 0.15rem 0.4rem;
      background: transparent;
      color: var(--text-dim);
      line-height: 1;
    }

    button:hover:not(:disabled) {
      color: var(--text);
    }

    button.done {
      border-color: var(--ok);
      color: var(--ok);
    }

    svg {
      width: 0.95em;
      height: 0.95em;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    span {
      font-size: var(--fx-typography--1);
    }
  `,
})
export class CopyButton {
  @Input({ required: true }) value = '';
  /** What is being copied, for anyone who cannot see the icon. */
  @Input({ required: true }) label = '';
  /** Shown next to the icon. Left empty the button is icon-only, which is what
   * a dense row wants. */
  @Input() text = '';
  @Input() title = '';

  private readonly copies$$ = new Subject<void>();

  protected readonly copied$ = this.copies$$.pipe(
    switchMap(() => timer(1600).pipe(map(() => false), startWith(true))),
    startWith(false),
  );

  protected async copy(): Promise<void> {
    // A rejected write - no permission, no clipboard API - must not light up
    // green, because the value the user thinks they have is then whatever was
    // in the clipboard before.
    await navigator.clipboard.writeText(this.value);
    this.copies$$.next();
  }
}
