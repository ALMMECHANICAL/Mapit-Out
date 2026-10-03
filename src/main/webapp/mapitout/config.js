/**
 * Map It Out - runtime configuration (loaded before js/main.js by mapitout.html).
 * Exposes window.MAPITOUT_CONFIG, which js/PreConfig.js hands to draw.io as DRAWIO_CONFIG
 * (bootstrap.js loads PreConfig.js after page scripts and resets DRAWIO_CONFIG).
 *
 * Wires draw.io's AI chat to a local LM Studio server (OpenAI-compatible API).
 * No upstream draw.io code is modified: everything goes through the documented
 * DRAWIO_CONFIG hook (see Editor.configure in js/diagramly/Editor.js).
 *
 * Override at deploy time by defining window.MAPITOUT_LLM before this file loads.
 */
(function()
{
	var llm = Object.assign({
		// LM Studio default. Enable "Serve on local network" + CORS in the
		// LM Studio server tab if the editor is served from another origin.
		baseUrl: 'http://localhost:1234/v1',
		// Model identifiers exactly as shown by GET {baseUrl}/models
		models: [
			{name: 'Local - Default (LM Studio)', model: 'local-model'}
		],
		// LM Studio ignores the key, but draw.io hides a model unless its
		// key is set, so a placeholder is required.
		apiKey: 'lm-studio'
	}, window.MAPITOUT_LLM || {});

	window.MAPITOUT_CONFIG = Object.assign({}, window.MAPITOUT_CONFIG, {
		enableAi: true,
		// Re-uses draw.io's built-in 'gpt' key slot (OpenAI-compatible request
		// shape) and points it at LM Studio. Gemini/Claude/GPT cloud models are
		// removed so nothing leaves the machine by default.
		gptApiKey: llm.apiKey,
		gptUrl: llm.baseUrl + '/chat/completions',
		aiActions: ['create', 'update', 'assist'], // no 'createPublic' (hosted draw.io)
		aiModels: llm.models.map(function(m)
		{
			return {name: m.name, model: m.model, config: 'gpt'};
		}),
		// Branding via draw.io's string-override hook
		resources: {appName: 'Map It Out'}
	});
})();
