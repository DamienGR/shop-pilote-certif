import { describe, it, expect } from 'vitest';
import { FREE_SHIPPING_LABEL, type ShippingConfig } from './calculator';
import { formatWeightValue } from './weight';
import {
  SHIPPING_SCHEMA_VERSION,
  documentToForm,
  effectiveShippingConfig,
  fingerprintRawConfig,
  legacyZoneName,
  migrationCandidate,
  parseRuntimeShippingConfig,
  parseShippingForm,
  serializeRuntimeShippingConfig,
  validateBuildTimeShipping,
  validateShippingDocument,
  type RuntimeShippingConfig,
} from './settings';

const buildTime: ShippingConfig = {
  enabled: true,
  zones: [
    {
      countries: ['US'],
      rates: [
        { label: 'Standard', amountCents: 500 },
        { label: 'Express', amountCents: 1500 },
      ],
      freeOverCents: 5000,
    },
  ],
};

const doc = (over: Partial<RuntimeShippingConfig> = {}): RuntimeShippingConfig => ({
  schema: SHIPPING_SCHEMA_VERSION,
  revision: 1,
  enabled: true,
  packageWeightGrams: 0,
  zones: [
    {
      name: '\u00c9tats-Unis',
      countries: ['US'],
      rates: [{ label: 'Standard', pricing: { type: 'flat', amountCents: 600 } }],
      freeOverCents: null,
    },
  ],
  ...over,
});

describe('parseRuntimeShippingConfig', () => {
  it('reports an absent row', () => {
    expect(parseRuntimeShippingConfig(null)).toEqual({ status: 'absent' });
    expect(parseRuntimeShippingConfig('')).toEqual({ status: 'absent' });
  });
  it('accepts a valid document', () => {
    const parsed = parseRuntimeShippingConfig(serializeRuntimeShippingConfig(doc()));
    expect(parsed.status).toBe('valid');
  });
  it('keeps the raw value for repair when the JSON is broken', () => {
    const parsed = parseRuntimeShippingConfig('{ not json');
    expect(parsed.status).toBe('invalid');
    if (parsed.status === 'invalid') expect(parsed.raw).toBe('{ not json');
  });
  it('rejects an unsupported schema version', () => {
    const parsed = parseRuntimeShippingConfig(JSON.stringify(doc({ schema: 99 })));
    expect(parsed.status).toBe('invalid');
  });
  it('rejects a document with no usable revision', () => {
    const parsed = parseRuntimeShippingConfig(JSON.stringify({ ...doc(), revision: 'x' }));
    expect(parsed.status).toBe('invalid');
  });
  it('rejects a schema 2 document with a non-boolean enabled', () => {
    // Coercing this to `false` would read as "the merchant switched shipping off"
    // and bypass checkout entirely — the opposite of failing closed.
    const parsed = parseRuntimeShippingConfig(JSON.stringify({ ...doc(), enabled: 'yes' }));
    expect(parsed.status).toBe('invalid');
  });
  it('rejects a schema 2 document with malformed zones or rates', () => {
    expect(parseRuntimeShippingConfig(JSON.stringify({ ...doc(), zones: 'US' })).status).toBe('invalid');
    const badZone = doc({ zones: [{ ...doc().zones[0]!, countries: [1, 2] } as never] });
    expect(parseRuntimeShippingConfig(JSON.stringify(badZone)).status).toBe('invalid');
    const badRate = doc({ zones: [{ ...doc().zones[0]!, rates: [{ label: 'X' }] as never }] });
    expect(parseRuntimeShippingConfig(JSON.stringify(badRate)).status).toBe('invalid');
  });
  it('rejects a schema 2 document with an invalid packaging weight', () => {
    const parsed = parseRuntimeShippingConfig(
      JSON.stringify({ ...doc(), packageWeightGrams: '40' }),
    );
    expect(parsed.status).toBe('invalid');
  });
  it('normalizes a schema 1 flat rate in memory', () => {
    const legacy = {
      schema: 1,
      revision: 3,
      enabled: true,
      zones: [
        {
          name: '\u00c9tats-Unis',
          countries: ['US'],
          rates: [{ label: 'Standard', amountCents: 500 }],
          freeOverCents: null,
        },
      ],
    };
    const parsed = parseRuntimeShippingConfig(JSON.stringify(legacy));
    expect(parsed.status).toBe('valid');
    if (parsed.status === 'valid') {
      expect(parsed.config.zones[0]!.rates[0]!.pricing).toEqual({ type: 'flat', amountCents: 500 });
      expect(parsed.config.packageWeightGrams).toBe(0);
    }
  });
});

describe('effectiveShippingConfig', () => {
  it('inherits build-time zones and the legacy enabled override when absent', () => {
    const off = effectiveShippingConfig(buildTime, { status: 'absent' }, false);
    expect(off.source).toBe('build-time');
    expect(off.config.enabled).toBe(false);
    expect(off.config.zones).toHaveLength(1);
    const on = effectiveShippingConfig(buildTime, { status: 'absent' }, null);
    expect(on.config.enabled).toBe(true);
  });
  it('lets a valid document replace build-time configuration entirely', () => {
    const parsed = parseRuntimeShippingConfig(
      serializeRuntimeShippingConfig(doc({ packageWeightGrams: 40 })),
    );
    const effective = effectiveShippingConfig(buildTime, parsed, false);
    expect(effective.source).toBe('admin');
    // The document owns `enabled`; the legacy override must not leak back in.
    expect(effective.config.enabled).toBe(true);
    expect(effective.config.packageWeightGrams).toBe(40);
    expect(effective.config.zones[0]!.name).toBe('\u00c9tats-Unis');
  });
  it('fails closed on an invalid document instead of restoring build-time rates', () => {
    const effective = effectiveShippingConfig(
      buildTime,
      { status: 'invalid', raw: 'x', error: 'broken' },
      null,
    );
    expect(effective.config.zones).toEqual([]);
    // Enabled must stay true: checkout bypasses shipping when disabled, so
    // flipping this would turn corrupt configuration into free shipping.
    expect(effective.config.enabled).toBe(true);
    expect(effective.issue).toEqual({ source: 'admin', reason: 'broken' });
  });
  it('fails closed on an over-cap build-time configuration', () => {
    const overCap: ShippingConfig = {
      enabled: true,
      zones: [
        {
          countries: ['US'],
          rates: [
            { label: 'A', amountCents: 100 },
            { label: 'B', amountCents: 200 },
            { label: 'C', amountCents: 300 },
            { label: 'D', amountCents: 400 },
            { label: 'E', amountCents: 500 },
          ],
          // Free shipping synthesizes a sixth option — one past Stripe's maximum.
          freeOverCents: 1000,
        },
      ],
    };
    expect(validateBuildTimeShipping(overCap)).toMatch(/au maximum 5 options/i);
    const effective = effectiveShippingConfig(overCap, { status: 'absent' }, null);
    expect(effective.config.zones).toEqual([]);
    expect(effective.issue?.source).toBe('build-time');
  });
  it('accepts a legacy threshold-only zone with no rates', () => {
    // The calculator has always synthesized free shipping for these; the Admin
    // editor requires a rate, but that rule must not retire a working store.
    const thresholdOnly: ShippingConfig = {
      enabled: true,
      zones: [{ countries: ['US'], rates: [], freeOverCents: 5000 }],
    };
    expect(validateBuildTimeShipping(thresholdOnly)).toBeNull();
    const effective = effectiveShippingConfig(thresholdOnly, { status: 'absent' }, null);
    expect(effective.issue).toBeNull();
    expect(effective.config.zones).toHaveLength(1);
  });
  it('still rejects a build-time zone with neither rates nor a threshold', () => {
    // Such a zone can ship nothing; the threshold-only exemption must not widen
    // into accepting it.
    const empty: ShippingConfig = {
      enabled: true,
      zones: [{ countries: ['US'], rates: [], freeOverCents: null }],
    };
    expect(validateBuildTimeShipping(empty)).toMatch(/au moins un tarif de livraison/i);
  });
  it('accepts an ordinary build-time configuration', () => {
    expect(validateBuildTimeShipping(buildTime)).toBeNull();
  });
  it('allows a disabled store with no zones', () => {
    expect(validateBuildTimeShipping({ enabled: false, zones: [] })).toBeNull();
  });
});

const messages = (config: RuntimeShippingConfig) =>
  validateShippingDocument(config).map((e) => e.message);

describe('validateShippingDocument', () => {
  it('accepts a well-formed document', () => {
    expect(validateShippingDocument(doc())).toEqual([]);
  });
  it('requires a zone and rate before enabling', () => {
    expect(messages(doc({ zones: [] }))).toContain(
      'Ajoutez au moins une zone avec un tarif avant d’activer la livraison.',
    );
  });
  it('rejects a country appearing in two zones', () => {
    const two = doc({
      zones: [
        { ...doc().zones[0]!, name: 'A' },
        { ...doc().zones[0]!, name: 'B' },
      ],
    });
    expect(messages(two).some((m) => /déjà dans une autre zone/.test(m))).toBe(true);
  });
  it('rejects duplicate zone names case-insensitively', () => {
    const two = doc({
      zones: [
        { ...doc().zones[0]!, name: 'Home' },
        { ...doc().zones[0]!, name: 'HOME', countries: ['CA'] },
      ],
    });
    expect(messages(two)).toContain('Une autre zone porte déjà ce nom.');
  });
  it('rejects an unknown country code', () => {
    expect(messages(doc({ zones: [{ ...doc().zones[0]!, countries: ['ZZ'] }] }))).toContain(
      'ZZ n’est pas un code pays.',
    );
  });
  it('keeps the catch-all alone and last', () => {
    const mixed = doc({ zones: [{ ...doc().zones[0]!, countries: ['*', 'US'] }] });
    expect(messages(mixed)).toContain(
      '«\u202fReste du monde\u202f» ne peut pas être combiné avec des pays précis.',
    );
    const notLast = doc({
      zones: [
        { ...doc().zones[0]!, name: 'World', countries: ['*'] },
        { ...doc().zones[0]!, name: 'US', countries: ['US'] },
      ],
    });
    expect(messages(notLast)).toContain('«\u202fReste du monde\u202f» doit être la dernière zone.');
  });
  it('rejects duplicate rate labels within a zone', () => {
    const dupe = doc({
      zones: [
        {
          ...doc().zones[0]!,
          rates: [
            { label: 'Standard', pricing: { type: 'flat', amountCents: 100 } },
            { label: 'standard', pricing: { type: 'flat', amountCents: 200 } },
          ],
        },
      ],
    });
    expect(messages(dupe)).toContain('Un autre tarif de cette zone porte déjà ce libellé.');
  });
  it('reserves the free-shipping label while a threshold is set', () => {
    const collide = doc({
      zones: [
        {
          ...doc().zones[0]!,
          freeOverCents: 5000,
          rates: [{ label: FREE_SHIPPING_LABEL, pricing: { type: 'flat', amountCents: 0 } }],
        },
      ],
    });
    expect(messages(collide).some((m) => /réservé/.test(m))).toBe(true);
  });
  it('enforces the five-option ceiling with the synthesized free option', () => {
    const rates = ['A', 'B', 'C', 'D', 'E'].map((label) => ({
      label,
      pricing: { type: 'flat' as const, amountCents: 100 },
    }));
    expect(messages(doc({ zones: [{ ...doc().zones[0]!, rates }] }))).toEqual([]);
    const withFree = doc({ zones: [{ ...doc().zones[0]!, rates, freeOverCents: 1000 }] });
    expect(messages(withFree).some((m) => /au maximum 5 options/i.test(m))).toBe(true);
  });
  it('requires strictly increasing band maxima', () => {
    const bands = doc({
      zones: [
        {
          ...doc().zones[0]!,
          rates: [
            {
              label: 'By weight',
              pricing: {
                type: 'weight',
                bands: [
                  { upToGrams: 1000, amountCents: 500 },
                  { upToGrams: 500, amountCents: 800 },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages(bands)).toContain(
      'Le maximum de chaque tranche doit dépasser celui de la tranche précédente.',
    );
  });
  it('allows no maximum only on the final band', () => {
    const bands = doc({
      zones: [
        {
          ...doc().zones[0]!,
          rates: [
            {
              label: 'By weight',
              pricing: {
                type: 'weight',
                bands: [
                  { upToGrams: null, amountCents: 500 },
                  { upToGrams: 1000, amountCents: 800 },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages(bands)).toContain('Seule la dernière tranche peut être sans maximum.');
  });
  it('accepts a pickup rate and validates its fee like a flat price', () => {
    const pickup = doc({
      zones: [
        {
          ...doc().zones[0]!,
          rates: [{ label: 'Local pickup', pricing: { type: 'pickup', amountCents: 0 } }],
        },
      ],
    });
    expect(validateShippingDocument(pickup)).toEqual([]);
    const bad = doc({
      zones: [
        {
          ...doc().zones[0]!,
          rates: [{ label: 'Local pickup', pricing: { type: 'pickup', amountCents: -1 } }],
        },
      ],
    });
    expect(messages(bad)).toContain('Indiquez un prix.');
  });
  it('requires at least one band on a weight rate', () => {
    const empty = doc({
      zones: [
        {
          ...doc().zones[0]!,
          rates: [{ label: 'By weight', pricing: { type: 'weight', bands: [] } }],
        },
      ],
    });
    expect(messages(empty)).toContain('Ajoutez au moins une tranche de poids.');
  });
});

describe('legacy migration', () => {
  it('names zones deterministically', () => {
    expect(legacyZoneName(['US'], 0)).toBe('\u00c9tats-Unis');
    expect(legacyZoneName(['*'], 1)).toBe('Reste du monde');
    expect(legacyZoneName(['US', 'CA'], 2)).toBe('Zone 3');
  });
  it('builds an editable candidate from raw build-time values', () => {
    const model = migrationCandidate(buildTime, null, 'usd');
    expect(model.revision).toBe(0);
    expect(model.zones[0]!.name).toBe('\u00c9tats-Unis');
    expect(model.zones[0]!.rates.map((r) => r.amountValue)).toEqual(['5', '15']);
    expect(model.zones[0]!.freeOverValue).toBe('50');
  });
  it('shows offending legacy values even when the storefront fails closed', () => {
    const broken: ShippingConfig = {
      enabled: true,
      zones: [{ countries: ['US', 'ZZ'], rates: [{ label: 'Std', amountCents: 500 }], freeOverCents: null }],
    };
    expect(effectiveShippingConfig(broken, { status: 'absent' }, null).config.zones).toEqual([]);
    // Admin still renders the bad code so the merchant can fix it.
    expect(migrationCandidate(broken, null, 'usd').zones[0]!.countries).toEqual(['US', 'ZZ']);
  });
});

describe('documentToForm', () => {
  it('round-trips amounts and weights into editable strings', () => {
    const model = documentToForm(
      doc({
        packageWeightGrams: 40,
        zones: [
          {
            name: '\u00c9tats-Unis',
            countries: ['US'],
            rates: [
              {
                label: 'By weight',
                pricing: {
                  type: 'weight',
                  bands: [
                    { upToGrams: 500, amountCents: 500 },
                    { upToGrams: null, amountCents: 2500 },
                  ],
                },
              },
            ],
            freeOverCents: 5000,
          },
        ],
      }),
      'usd',
      'g',
      formatWeightValue,
    );
    expect(model.packageWeightValue).toBe('40');
    expect(model.zones[0]!.freeOverValue).toBe('50');
    const bands = model.zones[0]!.rates[0]!.bands;
    expect(bands[0]).toMatchObject({ upToValue: '500', noMax: false, amountValue: '5' });
    expect(bands[1]).toMatchObject({ upToValue: '', noMax: true, amountValue: '25' });
  });
});

class TestForm {
  private data = new Map<string, string[]>();
  set(name: string, value: string) {
    this.data.set(name, [...(this.data.get(name) ?? []), value]);
    return this;
  }
  get(name: string) {
    return this.data.get(name)?.[0] ?? null;
  }
  getAll(name: string) {
    return this.data.get(name) ?? [];
  }
}

describe('parseShippingForm', () => {
  const submitted = () =>
    new TestForm()
      .set('enabled', '1')
      .set('revision', '3')
      .set('package_weight', '40')
      .set('zone_order', 'z_a,z_b')
      .set('zone[z_a][name]', '\u00c9tats-Unis')
      .set('zone[z_a][countries][]', 'us')
      .set('zone[z_a][rate_order]', 'r_1,r_2')
      .set('zone[z_a][rate][r_1][label]', 'Standard')
      .set('zone[z_a][rate][r_1][mode]', 'flat')
      .set('zone[z_a][rate][r_1][amount]', '6.00')
      .set('zone[z_a][rate][r_2][label]', 'By weight')
      .set('zone[z_a][rate][r_2][mode]', 'weight')
      .set('zone[z_a][rate][r_2][band_order]', 'b_1,b_2')
      .set('zone[z_a][rate][r_2][band][b_1][up_to]', '500')
      .set('zone[z_a][rate][r_2][band][b_1][amount]', '5')
      .set('zone[z_a][rate][r_2][band][b_2][no_max]', '1')
      .set('zone[z_a][rate][r_2][band][b_2][amount]', '25')
      .set('zone[z_a][free_over]', '50')
      .set('zone[z_b][name]', 'Rest of world')
      .set('zone[z_b][countries][]', '*')
      .set('zone[z_b][rate_order]', 'r_3')
      .set('zone[z_b][rate][r_3][label]', 'International')
      .set('zone[z_b][rate][r_3][mode]', 'flat')
      .set('zone[z_b][rate][r_3][amount]', '30');

  it('parses a complete submission into a valid document', () => {
    const { document, revision, errors } = parseShippingForm(submitted(), {
      currency: 'usd',
      unit: 'g',
    });
    expect(errors).toEqual([]);
    expect(revision).toBe(3);
    expect(document.enabled).toBe(true);
    expect(document.packageWeightGrams).toBe(40);
    expect(document.zones[0]!.countries).toEqual(['US']);
    expect(document.zones[0]!.rates[0]!.pricing).toEqual({ type: 'flat', amountCents: 600 });
    expect(document.zones[0]!.rates[1]!.pricing).toEqual({
      type: 'weight',
      bands: [
        { upToGrams: 500, amountCents: 500 },
        { upToGrams: null, amountCents: 2500 },
      ],
    });
    expect(document.zones[1]!.rates[0]!.pricing).toEqual({ type: 'flat', amountCents: 3000 });
  });
  it('preserves order and ignores unreferenced rows', () => {
    const form = submitted().set('zone[z_ghost][name]', 'Nowhere');
    const { document } = parseShippingForm(form, { currency: 'usd', unit: 'g' });
    expect(document.zones.map((z) => z.name)).toEqual(['\u00c9tats-Unis', 'Rest of world']);
  });
  it('parses a pickup rate from the editor', () => {
    const form = new TestForm()
      .set('enabled', '1')
      .set('revision', '1')
      .set('zone_order', 'z_a')
      .set('zone[z_a][name]', 'US')
      .set('zone[z_a][countries][]', 'US')
      .set('zone[z_a][rate_order]', 'r_1')
      .set('zone[z_a][rate][r_1][label]', 'Local pickup')
      .set('zone[z_a][rate][r_1][mode]', 'pickup')
      .set('zone[z_a][rate][r_1][amount]', '0');
    const { document, errors } = parseShippingForm(form, { currency: 'usd', unit: 'g' });
    expect(errors).toEqual([]);
    expect(document.zones[0]!.rates[0]!.pricing).toEqual({ type: 'pickup', amountCents: 0 });
  });
  it('scales amounts by the currency, not by a hardcoded 100', () => {
    const { document } = parseShippingForm(submitted(), { currency: 'jpy', unit: 'g' });
    expect(document.zones[0]!.rates[0]!.pricing).toEqual({ type: 'flat', amountCents: 6 });
  });
  it('reports a band weight the merchant mistyped', () => {
    const bad = new TestForm()
      .set('enabled', '1')
      .set('revision', '1')
      .set('zone_order', 'z_a')
      .set('zone[z_a][name]', 'US')
      .set('zone[z_a][countries][]', 'US')
      .set('zone[z_a][rate_order]', 'r_1')
      .set('zone[z_a][rate][r_1][label]', 'By weight')
      .set('zone[z_a][rate][r_1][mode]', 'weight')
      .set('zone[z_a][rate][r_1][band_order]', 'b_1')
      .set('zone[z_a][rate][r_1][band][b_1][up_to]', 'heavy')
      .set('zone[z_a][rate][r_1][band][b_1][amount]', '5');
    const { errors } = parseShippingForm(bad, { currency: 'usd', unit: 'g' });
    expect(errors.some((e) => e.field === 'upTo')).toBe(true);
  });
});

describe('fingerprintRawConfig', () => {
  it('is stable for the same bytes and differs for a repair', async () => {
    const a = await fingerprintRawConfig('{ broken');
    expect(await fingerprintRawConfig('{ broken')).toBe(a);
    expect(await fingerprintRawConfig('{ broken ')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
