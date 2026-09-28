import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * One header shape for every page.
 *
 * Each screen had grown its own: a bare h1 here, an h1 with controls hanging
 * off it there, an intro paragraph on one. Five pages that each look like the
 * first page of a different application. The subtitle is not decoration — it
 * is the one line that says what this screen answers, which is the difference
 * between a console you learn and one you are shown.
 *
 * Actions project into the right-hand side, so filters and range pickers line
 * up on the same baseline everywhere.
 */
@Component({
  selector: 'wt-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="fx-flex fx-flex-wrap fx-items-start fx-gap-4 fx-mb-5">
      <div class="titles fx-flex fx-flex-col fx-gap-1">
        <h1>{{ heading() }}</h1>
        @if (subtitle()) {
          <p class="subtitle dim">{{ subtitle() }}</p>
        }
      </div>

      <div class="actions fx-inline-flex fx-flex-wrap fx-items-center fx-gap-2 fx-ml-a">
        <ng-content />
      </div>
    </header>
  `,
  styles: `
    :host {
      display: block;
    }

    h1 {
      margin: 0;
      font-size: var(--fx-typography-3);
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .subtitle {
      margin: 0;
      max-width: 70ch;
      font-size: var(--fx-typography--1);
    }

    /* The actions sit on the title's baseline rather than the block's, so a
       tall control does not drag the row down with it. */
    .actions {
      align-self: center;
    }
  `,
})
export class PageHeader {
  readonly heading = input.required<string>();
  readonly subtitle = input('');
}
