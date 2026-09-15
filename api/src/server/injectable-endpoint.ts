import { ClassNameSymbol, InjectableDecorator } from '@microphi/di';

/**
 * `@Injectable()` for classes that also carry apigator's `@Lambda`.
 *
 * `@Injectable()` registers a *subclass* and keys the container off a static
 * `[ClassNameSymbol]` defined on it. `@Lambda` resolves its instance with
 * `injector(target.constructor)`, and because method decorators run before
 * class decorators that constructor is the original, undecorated class — which
 * carries no such key, so every request fails with "is it annotated with
 * @Injectable()?".
 *
 * Copying the key onto the original makes both spellings of the class resolve
 * to the same registration, and therefore to the same singleton. The real fix
 * belongs in apigator, which should resolve the decorated class.
 */
export function InjectableEndpoint(): ClassDecorator {
  return (target) => {
    const decorated = InjectableDecorator(target as never) as unknown as Record<symbol, string>;

    Object.defineProperty(target, ClassNameSymbol, {
      value: decorated[ClassNameSymbol],
      enumerable: false,
      configurable: true,
    });

    return decorated as never;
  };
}
