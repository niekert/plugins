curl -X POST "https://hooks.slack.com/triggers/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" \
  -H "Content-Type: application/json" \
  -d '{"githubActionRunUrl":"https://github.com/niekert/plugins/actions/runs/21680981907/job/62515037566","errorMessage":"No changes detected since last release. Nothing to submit."}'
