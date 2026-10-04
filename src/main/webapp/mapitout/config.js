/**
 * Map It Out - runtime configuration (loaded before js/main.js by mapitout.html).
 * Exposes window.MAPITOUT_CONFIG and also sets window.DRAWIO_CONFIG directly. js/PreConfig.js
 * re-applies it (bootstrap.js loads PreConfig.js after page scripts and resets DRAWIO_CONFIG),
 * but bootstrap.js skips PreConfig.js entirely on *.draw.io / *.diagrams.net hostnames, so the
 * direct assignment keeps the backend enforced there too.
 *
 * Wires draw.io's AI chat to a local LM Studio server (OpenAI-compatible API).
 * No upstream draw.io code is modified: everything goes through the documented
 * DRAWIO_CONFIG hook (see Editor.configure in js/diagramly/Editor.js).
 *
 * Override at deploy time by editing mapitout/env.js (loaded before this file), which may
 * define window.MAPITOUT_LLM = {baseUrl, models, apiKey}.
 */
(function()
{
	var llm = Object.assign({
		// LM Studio default. Enable "Serve on local network" + CORS in the
		// LM Studio server tab if the editor is served from another origin.
		baseUrl: 'http://localhost:1234/v1',
		// Model identifiers must match GET {baseUrl}/models exactly. 'local-model' is only a
		// placeholder: set the real id in mapitout/env.js (a console warning is shown otherwise).
		models: [
			{name: 'Local - set model id in env.js', model: 'local-model'}
		],
		// LM Studio ignores the key, but draw.io hides a model unless its
		// key is set, so a placeholder is required.
		apiKey: 'lm-studio'
	}, window.MAPITOUT_LLM || {});

	if (llm.models.some(function(m) { return m.model === 'local-model'; }) && window.console)
	{
		console.warn('Map It Out: AI model id is the placeholder "local-model". Set the id shown by ' +
			llm.baseUrl + '/models in mapitout/env.js (window.MAPITOUT_LLM).');
	}

	window.MAPITOUT_CONFIG = Object.assign({}, window.MAPITOUT_CONFIG, {
		enableAi: true,
		// Separate storage namespace: a stock editor's saved '.configuration' (same origin)
		// must never override the local-only AI backend below.
		settingsName: 'mapitout',
		// Re-uses draw.io's built-in 'gpt' key slot (OpenAI-compatible request
		// shape) and points it at LM Studio. Gemini/Claude/GPT cloud models are
		// removed so nothing leaves the machine by default.
		gptApiKey: llm.apiKey,
		gptUrl: llm.baseUrl + '/chat/completions',
		aiActions: ['create', 'update', 'assist'], // no 'createPublic' (hosted draw.io)
		aiModels: llm.models.map(function(m)
		{
			return {name: m.name, model: m.model, config: 'gpt'};
		})
	});
	window.DRAWIO_CONFIG = window.MAPITOUT_CONFIG;
})();
