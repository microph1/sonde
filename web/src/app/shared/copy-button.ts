import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
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
  imports: [AsyncPipe, MatButtonModule, MatIconModule, MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (text) {
      <button
        mat-stroked-button
        type="button"
        [class.done]="copied$ | async"
        [attr.aria-label]="label"
        [matTooltip]="title || label"
        (click)="copy()"
      >
        <mat-icon>{{ (copied$ | async) ? 'check' : 'content_copy' }}</mat-icon>
        {{ (copied$ | async) ? 'Copied' : text }}
      </button>
    } @else {
      <button
        mat-icon-button
        type="button"
        [class.done]="copied$ | async"
        [attr.aria-label]="label"
        [matTooltip]="title || label"
        (click)="copy()"
      >
        <mat-icon>{{ (copied$ | async) ? 'check' : 'content_copy' }}</mat-icon>
      </button>
    }
  `,
  styles: `
    button.done {
      color: var(--ok);
    }

    mat-icon {
      font-size: 1.05rem;
      width: 1.05rem;
      height: 1.05rem;
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
