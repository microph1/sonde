# Web

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.10.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

```bash
npx playwright test
```

These are system tests, not component tests: they drive the real console against
the real API, ClickHouse and Redpanda, and seed their data by posting OTLP to the
receiver like any other client would. Every bug they have caught has been an
integration bug, which is the argument for running them that way.

What has to be up first:

- the stack — `docker compose up -d` from the repository root;
- the read API, **with authentication on**. `SONDE_AUTH_DISABLED=true` skips the
  Dex redirect, and the suite signs in through it:

  ```bash
  SONDE_OIDC_ISSUER=http://localhost:5556/dex \
  SONDE_OIDC_CLIENT_ID=sonde \
  SONDE_OIDC_CLIENT_SECRET=dev-client-secret \
  SONDE_SESSION_SECRET=dev-session-secret-change-me \
  SONDE_PUBLIC_URL=http://localhost:4200 \
  node dist/main.js
  ```

The dev server is started by Playwright if nothing is already listening on 4200.

Sign-in happens once, in `login.setup.ts`, and the session is reused by every
other spec — through the real identity provider rather than by forging a cookie,
because a forged session proves the console renders while saying nothing about
whether anyone can get into it. It signs in as `e2e@local` / `sonde-e2e`, a
static account in `dex/config.yaml` that exists so the suite does not depend on a
password only one person knows. Override with `SONDE_E2E_USER` and
`SONDE_E2E_PASSWORD`.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
