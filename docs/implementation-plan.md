# Silent Brain service implementation plan

Goal: main agents call a plugin-owned text conversation service that directly requests the configured loopback OpenAI-compatible gateway. No DSH child agent, inherited tools, or companion preset is created.

1. Test a local HTTP fixture before implementation: owner isolation, multi-turn history, same-session serialization, independent-session concurrency, failed-turn rollback, cancellation and request size budget. Assert requests contain no tools or tool_choice.
2. Implement lib/brain-service.js: in-memory conversations keyed by owner id and conversation label; fixed bundled system prompt; bounded recent turns; direct POST /v1/chat/completions; model and endpoint receipt; explicit errors on HTTP failure, empty content or mismatched response model. Keep old history on failure.
3. Implement lib/brain-tool.js: tabbit_brain accepts description/prompt/conversation/run_in_background. Register in ordinary main-agent scopes. Default background=true uses DSH jobs.start; job cancellation aborts fetch. tabbit_brain_reset removes one idle conversation. No UI panel, no agent factory and no subagent registry.
4. Replace the legacy provider entry: retain gateway lazy-start and delegation guidance, remove DSH child-creation imports and preset settings. Resolve API key from a configured environment-variable name, never log it. Use settings snapshots per request. Dispose service with plugin.
5. Update installation assistant to register the LLM endpoint without requiring a main or child preset. Remove obsolete local manual subagent_tabbit row. Document memory lifetime, reset, budget and gateway remote-session limitation.
6. Run fixture tests, syntax, isolated setup tests, package checks and secret scan. Run one direct real-gateway call without tools and verify returned route metadata; host tool/background/new-session behaviour requires DSH restart. Do not claim that local history isolation guarantees remote Tabbit-session isolation.

Constraints: Windows gateway only; no credential extraction outside existing user-approved gateway flow; no browser shutdown during testing; no automatic UI, remote publish or tag as part of this migration. Preserve current working changes until verified; no git history rewrite.
