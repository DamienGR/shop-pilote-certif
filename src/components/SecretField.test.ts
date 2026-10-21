import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SecretField from './SecretField.astro';

const render = async (props: Record<string, unknown>) => {
  const container = await AstroContainer.create();
  return container.renderToString(SecretField as never, {
    props: { name: 'resend_api_key', label: 'Clé', vault: true, storedInD1: true, ...props },
  });
};

const keyInput = (html: string) => html.match(/<input[^>]*name="secret:resend_api_key"[^>]*>/)?.[0] ?? '';

describe('SecretField', () => {
  it('asks browsers not to fill a saved login into the key field', async () => {
    const input = keyInput(await render({}));
    expect(input).toContain('type="password"');
    // `off` is ignored on a password field: the saved admin password went in.
    expect(input).toContain('autocomplete="new-password"');
    expect(input).not.toContain('autocomplete="off"');
  });

  it('asks password managers to leave it alone too', async () => {
    const input = keyInput(await render({}));
    for (const attribute of ['data-1p-ignore', 'data-lpignore="true"', 'data-bwignore', 'data-form-type="other"']) {
      expect(input).toContain(attribute);
    }
  });

  it('never renders a stored value', async () => {
    const input = keyInput(await render({ storedInD1: true }));
    expect(input).not.toMatch(/\svalue=/);
  });
});
