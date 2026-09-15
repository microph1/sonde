import { ChangeDetectionStrategy, Component, inject, resource } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { Telemetry } from '../../core/telemetry';

@Component({
  selector: 'wt-services-view',
  imports: [RouterLink, DatePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Services</h1>

    @if (services.isLoading()) {
      <p class="hint">Loading…</p>
    } @else if (services.error(); as error) {
      <p role="alert" class="error">{{ error }}</p>
    } @else {
      <table>
        <caption class="sr-only">Services reporting telemetry</caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Spans</th>
            <th scope="col">Logs</th>
            <th scope="col">Last seen</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          @for (service of services.value(); track service.ServiceName) {
            <tr>
              <th scope="row" class="mono">{{ service.ServiceName }}</th>
              <td>{{ service.traces | number }}</td>
              <td>{{ service.logs | number }}</td>
              <td>{{ service.lastSeen | date: 'medium' }}</td>
              <td class="links">
                <a [routerLink]="['/traces']" [queryParams]="{ service: service.ServiceName }">traces</a>
                <a [routerLink]="['/logs']" [queryParams]="{ service: service.ServiceName }">logs</a>
              </td>
            </tr>
          } @empty {
            <tr><td colspan="5" class="hint">Nothing has reported yet.</td></tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: `
    .links {
      display: flex;
      gap: 0.75rem;
    }

    .hint {
      color: var(--text-dim);
    }

    .error {
      color: var(--error);
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class ServicesView {
  private readonly telemetry = inject(Telemetry);

  protected readonly services = resource({
    loader: () => this.telemetry.services(),
  });
}
