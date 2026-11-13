// OpenAPI 3.1 description of the public + integration API. Served at /api/openapi.json, docs at /docs.
export function openapi(baseUrl) {
  const ref = n => ({ $ref: `#/components/schemas/${n}` });
  const json = schema => ({ content: { 'application/json': { schema } } });
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
  const crud = (tag, name, schemaName) => ({
    [`/api/v1/${name}`]: {
      get: { tags: [tag], summary: `List ${name}`, security: [{ ApiKey: [] }], responses: { 200: json({ type: 'array', items: ref(schemaName) }) } },
      post: { tags: [tag], summary: `Create ${name.replace(/s$/, '')}`, security: [{ ApiKey: [] }], requestBody: json(ref(schemaName)), responses: { 201: json(ref(schemaName)) } },
    },
    [`/api/v1/${name}/{id}`]: {
      get: { tags: [tag], summary: `Get one`, security: [{ ApiKey: [] }], parameters: [idParam], responses: { 200: json(ref(schemaName)), 404: { description: 'Not found' } } },
      patch: { tags: [tag], summary: `Update`, security: [{ ApiKey: [] }], parameters: [idParam], requestBody: json(ref(schemaName)), responses: { 200: json(ref(schemaName)) } },
      delete: { tags: [tag], summary: `Delete`, security: [{ ApiKey: [] }], parameters: [idParam], responses: { 204: { description: 'Deleted' } } },
    },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: '3D Shed Builder API',
      version: '1.0.0',
      description: `REST API for the 3D Shed Builder.

**Authentication** — create an API key in *Admin → Integrations → API keys* and send it as \`X-API-Key: sb_live_…\` (or \`Authorization: Bearer sb_live_…\`).
Public endpoints (catalog, pricing, quote submission) need no key so the configurator can be embedded anywhere.

**Webhooks** — subscribe with \`POST /api/v1/webhooks\` (REST-hook style, works with Zapier/Make/n8n) or in the admin.
Every delivery is a JSON \`POST\` of \`{ event, delivery_id, sent_at, data }\` where \`data\` is a **Quote**.
If the webhook has a secret, the body is signed: \`X-ShedBuilder-Signature: sha256=HMAC_SHA256(secret, rawBody)\`.
Failed deliveries are retried after 1s, 5s and 25s.

**Events** — \`quote.created\`, \`quote.updated\`, \`quote.status_changed\`, \`test\`, or \`*\` for all.`,
    },
    servers: [{ url: baseUrl || '/' }],
    tags: [
      { name: 'Public', description: 'No API key required' }, { name: 'Quotes' }, { name: 'Webhooks' },
      { name: 'Catalog: Styles' }, { name: 'Catalog: Sizes' }, { name: 'Catalog: Colors' }, { name: 'Catalog: Options' },
    ],
    components: {
      securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
      schemas: {
        Config: {
          type: 'object', required: ['style_id', 'size_id'],
          description: 'A shed configuration exactly as built in the 3D configurator.',
          properties: {
            style_id: { type: 'integer' }, size_id: { type: 'integer' },
            roof_material: { type: 'string', example: 'metal', description: 'Roofing material key (e.g. shingle = Architectural Shingles, metal = Ag Panel Metal)' },
            dealer_id: { type: 'string', description: 'Pricing by dealer lot: the dealer lot id (see catalog settings.dealers)' },
            zip: { type: 'string', description: 'Pricing by ZIP: the customer ZIP used to pick the price tier' },
            colors: { type: 'object', properties: { siding: { type: 'integer' }, trim: { type: 'integer' }, roof: { type: 'integer' }, door: { type: 'integer' }, window: { type: 'integer' } } },
            items: {
              type: 'array', items: {
                type: 'object', required: ['option_id'], properties: {
                  option_id: { type: 'integer' },
                  wall: { type: 'string', enum: ['front', 'back', 'left', 'right', 'ceiling', 'roof'], nullable: true },
                  offset: { type: 'number', description: 'Feet from the centre of the wall (viewed from outside, + is to the right)' },
                  w: { type: 'number', description: 'Optional width override (ft)' }, h: { type: 'number', description: 'Optional height override (ft)' },
                  qty: { type: 'integer', default: 1 },
                  standard_of: { type: 'integer', nullable: true, description: 'If this item replaced a standard option, the original option id' },
                },
              },
            },
          },
        },
        Customer: {
          type: 'object', required: ['first_name', 'email'],
          properties: {
            first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string', format: 'email' }, phone: { type: 'string' },
            address: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, zip: { type: 'string' }, notes: { type: 'string' },
            sms_consent: { type: 'boolean' },
          },
        },
        Pricing: {
          type: 'object', properties: {
            lines: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, label: { type: 'string' }, amount: { type: 'number' }, note: { type: 'string' } } } },
            subtotal: { type: 'number' }, delivery: { type: 'number' }, tax: { type: 'number' }, tax_rate: { type: 'number' }, total: { type: 'number' },
          },
        },
        Quote: {
          type: 'object', properties: {
            id: { type: 'integer' }, number: { type: 'string', example: 'Q-24051' }, status: { type: 'string', example: 'new' },
            created_at: { type: 'string' }, updated_at: { type: 'string' },
            customer: { allOf: [ref('Customer')], properties: { full_name: { type: 'string' } } },
            shed: { type: 'object', properties: { style: { type: 'string' }, size: { type: 'string' }, roofing: { type: 'string', example: 'Ag Panel Metal' }, width_ft: { type: 'number' }, depth_ft: { type: 'number' }, sq_ft: { type: 'number' }, colors: { type: 'object', additionalProperties: { type: 'string' } } } },
            options: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, category: { type: 'string' }, wall: { type: 'string' }, price: { type: 'number' }, note: { type: 'string' } } } },
            pricing: { type: 'object', properties: { subtotal: { type: 'number' }, delivery: { type: 'number' }, tax: { type: 'number' }, total: { type: 'number' }, tier: { type: 'string', description: 'Price tier used' }, pricing_zip: { type: 'string' } } },
            dealer: { type: 'object', nullable: true, properties: { id: { type: 'string' }, name: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } } },
            summary: { type: 'string', description: 'One-line human readable summary — handy for CRM notes/SMS' },
            links: { type: 'object', properties: { view_3d: { type: 'string' }, download_3d_model: { type: 'string' }, floor_plan_svg: { type: 'string' }, admin: { type: 'string' } } },
            config: ref('Config'),
          },
        },
        Webhook: {
          type: 'object', required: ['url'], properties: {
            id: { type: 'integer', readOnly: true }, name: { type: 'string' }, url: { type: 'string', format: 'uri' },
            events: { type: 'array', items: { type: 'string', enum: ['quote.created', 'quote.updated', 'quote.status_changed', 'test', '*'] } },
            secret: { type: 'string', description: 'Optional HMAC signing secret' },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra headers to send (e.g. auth for the receiver)' },
            active: { type: 'integer', enum: [0, 1] },
          },
        },
        Style: {
          type: 'object', properties: {
            id: { type: 'integer', readOnly: true }, name: { type: 'string' }, description: { type: 'string' }, image_url: { type: 'string' },
            roof_type: { type: 'string', enum: ['gable', 'barn', 'lean_to', 'saltbox'] }, ridge_axis: { type: 'string', enum: ['depth', 'width'] },
            wall_height: { type: 'number' }, roof_pitch: { type: 'number', description: 'Rise per 12" of run (upper slope on gambrel roofs)' }, roof_pitch_lower: { type: 'number', description: 'Gambrel lower-slope pitch (rise per 12")' }, gambrel_break: { type: 'number', description: 'Gambrel break: lower slope run as % of half the span (used when gambrel_lower_len is empty)' }, gambrel_lower_len: { type: 'number', description: 'Gambrel lower section length along the slope (ft)' }, roof_pitch_back: { type: 'number', description: 'Saltbox back-slope pitch (rise per 12")' }, overhang: { type: 'number', description: 'Eave overhang (ft)' },
            gable_overhang: { type: 'number', nullable: true, description: 'Gable/rake overhang (ft); null = same as eave' },
            fascia_size: { type: 'number', description: 'Fascia board height (inches, default 5.5)' }, rake_size: { type: 'number', description: 'Shingle-roof rake board height (inches, default 5.5)' }, metal_rake_size: { type: 'number', description: 'Metal rake trim height (inches, default 5.5)' }, metal_rake_leg: { type: 'number', description: 'Metal rake leg onto the roofing (inches)' }, roof_edge: { type: 'string', enum: ['metal_rake', 'board_drip'], description: 'metal_rake = wide roof-color rake trim; board_drip = trim-color rake board + fascia with a thin metal rake edge and drip edge' }, rake_cap_size: { type: 'number', description: 'board_drip: metal rake edge height (inches, default 1.5)' }, drip_edge_size: { type: 'number', description: 'board_drip: drip edge height (inches, default 1.5)' }, drip_edge_color: { type: 'string', enum: ['roof', 'trim'] },
            corner_trim: { type: 'number', description: 'Corner board width (inches, default 5)' }, casing_trim: { type: 'number', description: 'Door/window trim width (inches, default 4)' },
            roof_choices: { type: 'array', items: { type: 'string' }, description: 'Roofing materials customers may choose' },
            siding_type: { type: 'string', enum: ['lp_smartside', 'lap', 'board_batten', 't111', 'metal'] }, trim_type: { type: 'string', enum: ['lp', 'smooth'] }, roof_material: { type: 'string', description: 'Default (included) roofing material key' },
            gambrel_upper_len: { type: ['number', 'null'], description: 'Lofted barn: upper section length along the slope (ft). When set, the upper pitch follows from it.' },
            rake_tail: { type: ['string', 'null'], enum: ['level', 'plumb', null], description: 'Rake / fly-rafter tail cut: level (flat at the fascia bottom) or plumb. null = flat on barns, plumb on others.' },
            available_options: { type: ['array', 'null'], items: { type: 'integer' }, description: 'Option ids offered on this style. null = every option. Standard options are always available.' },
            standard_options: { type: 'array', items: { type: 'object', properties: { option_id: { type: 'integer' }, wall: { type: 'string' }, offset: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, gable: { type: 'boolean', description: 'Sit up in the gable (options with gable_mode allow/only)' } } } },
            default_colors: { type: 'object' }, active: { type: 'integer' }, sort: { type: 'integer' },
          },
        },
        Size: { type: 'object', properties: { id: { type: 'integer', readOnly: true }, style_id: { type: 'integer' }, width: { type: 'number' }, depth: { type: 'number' }, price: { type: 'number' }, hip_len: { type: ['number', 'null'], description: 'Lofted barn: hip (lower section) length for this size, ft' }, upper_len: { type: ['number', 'null'], description: 'Lofted barn: upper section length for this size, ft' }, active: { type: 'integer' }, sort: { type: 'integer' } } },
        Color: { type: 'object', properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string' }, hex: { type: 'string' }, uses: { type: 'array', items: { type: 'string', enum: ['siding', 'trim', 'door', 'window', 'roof'] }, description: 'Where this paint is offered (enter once, use for several). Empty = just its category.' }, category: { type: 'string', enum: ['siding', 'trim', 'roof', 'door', 'window'] }, material: { type: 'string', nullable: true, description: 'Roof colors: which roofing material it is offered for (null = all)' }, price: { type: 'number' }, active: { type: 'integer' } } },
        Option: {
          type: 'object', properties: {
            id: { type: 'integer', readOnly: true }, name: { type: 'string' }, description: { type: 'string' },
            category: { type: 'string', enum: ['doors', 'windows', 'interior', 'electrical', 'exterior', 'upgrades'] },
            kind: { type: 'string', description: 'Built-in 3D model' }, placement: { type: 'string', enum: ['opening', 'wall_interior', 'wall_exterior', 'ceiling', 'loft', 'ground', 'roof', 'none'] },
            swap_group: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, depth: { type: 'number' }, elevation: { type: 'number', description: 'Standard height: bottom of the item above the floor (ft)' }, package_items: { type: ['array', 'null'], description: 'Makes this option a package. Each item: { option_id, qty, wall: auto|front|back|left|right|ceiling, offset (ft from wall centre, seen from outside; null = auto), elev (ft, optional) }. Package items are placed automatically and priced as included.', items: { type: 'object', properties: { option_id: { type: 'integer' }, qty: { type: 'integer' }, wall: { type: 'string' }, offset: { type: ['number', 'null'] }, elev: { type: 'number' } } } }, package_only: { type: 'integer', description: '1 = only sold inside a package (e.g. breaker box)' }, gable_mode: { type: 'string', enum: ['', 'allow', 'only'], description: "Windows/vents: '' = walls only, allow = wall or up in the gable, only = gable only" },
            price: { type: 'number' }, price_unit: { type: 'string', enum: ['each', 'per_ft_wall', 'per_ft_width', 'per_ft_depth', 'per_sqft', 'per_ft_perimeter'] },
            model_url: { type: 'string', description: 'Custom .glb model (overrides built-in kind)' }, image_url: { type: 'string' }, active: { type: 'integer' },
          },
        },
      },
    },
    paths: {
      '/api/v1/catalog': { get: { tags: ['Public'], summary: 'Everything the configurator needs: styles (with sizes), colors, options and display settings', responses: { 200: { description: 'Catalog' } } } },
      '/api/v1/price': { post: { tags: ['Public'], summary: 'Price a configuration (server-side, authoritative)', requestBody: json(ref('Config')), responses: { 200: json(ref('Pricing')) } } },
      '/api/v1/quotes': {
        post: {
          tags: ['Public', 'Quotes'], summary: 'Submit a quote', description: 'Prices the config on the server, stores the quote, then fires `quote.created` to webhooks and GoHighLevel.',
          requestBody: json({ type: 'object', required: ['config', 'customer'], properties: { config: ref('Config'), customer: ref('Customer'), source: { type: 'string' }, utm: { type: 'object' } } }),
          responses: { 201: json(ref('Quote')), 400: { description: 'Validation error' } },
        },
        get: {
          tags: ['Quotes'], summary: 'List quotes', security: [{ ApiKey: [] }],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'dealer', in: 'query', schema: { type: 'string' }, description: 'Dealer lot id' }, { name: 'since', in: 'query', schema: { type: 'string' }, description: 'ISO date — only quotes created after' },
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search name/email/phone/number' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { 200: json({ type: 'object', properties: { total: { type: 'integer' }, data: { type: 'array', items: ref('Quote') } } }) },
        },
      },
      '/api/v1/quotes/{id}': {
        get: { tags: ['Quotes'], summary: 'Get a quote', security: [{ ApiKey: [] }], parameters: [idParam], responses: { 200: json(ref('Quote')) } },
        patch: {
          tags: ['Quotes'], summary: 'Update status / notes', security: [{ ApiKey: [] }], parameters: [idParam],
          requestBody: json({ type: 'object', properties: { status: { type: 'string', example: 'won' }, internal_notes: { type: 'string' } } }),
          responses: { 200: json(ref('Quote')) },
        },
        delete: { tags: ['Quotes'], summary: 'Delete a quote', security: [{ ApiKey: [] }], parameters: [idParam], responses: { 204: { description: 'Deleted' } } },
      },
      '/api/v1/quotes/{id}/floorplan.svg': { get: { tags: ['Quotes'], summary: 'Floor plan (SVG, to scale)', security: [{ ApiKey: [] }], parameters: [idParam], responses: { 200: { description: 'SVG', content: { 'image/svg+xml': {} } } } } },
      '/api/v1/quotes/{id}/resend': { post: { tags: ['Quotes'], summary: 'Re-send quote.created to all webhooks + GHL', security: [{ ApiKey: [] }], parameters: [idParam], responses: { 202: { description: 'Queued' } } } },
      ...crud('Webhooks', 'webhooks', 'Webhook'),
      '/api/v1/webhooks/{id}/test': { post: { tags: ['Webhooks'], summary: 'Send a test event', security: [{ ApiKey: [] }], parameters: [idParam], responses: { 200: { description: 'Delivery result' } } } },
      ...crud('Catalog: Styles', 'styles', 'Style'),
      ...crud('Catalog: Sizes', 'sizes', 'Size'),
      ...crud('Catalog: Colors', 'colors', 'Color'),
      ...crud('Catalog: Options', 'options', 'Option'),
    },
  };
}
