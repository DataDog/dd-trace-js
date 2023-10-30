/* eslint-disable max-len */
'use strict'

module.exports = [
  {
    'id': 'adobe-client-secret',
    'regex': /\b((p8e-)[a-z0-9]{32})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'age-secret-key',
    'regex': /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/
  },
  {
    'id': 'alibaba-access-key-id',
    'regex': /\b((LTAI)[a-z0-9]{20})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'authress-service-client-access-key',
    'regex': /\b((?:sc|ext|scauth|authress)_[a-z0-9]{5,30}\.[a-z0-9]{4,6}\.acc[_-][a-z0-9-]{10,32}\.[a-z0-9+/_=-]{30,120})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'aws-access-token',
    'regex': /\b((A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16})(?:['"\s\x60;]|$)/
  },
  {
    'id': 'clojars-api-token',
    'regex': /(CLOJARS_)[a-z0-9]{60}/i
  },
  {
    'id': 'databricks-api-token',
    'regex': /\b(dapi[a-h0-9]{32})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'digitalocean-access-token',
    'regex': /\b(doo_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'digitalocean-pat',
    'regex': /\b(dop_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'digitalocean-refresh-token',
    'regex': /\b(dor_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'doppler-api-token',
    'regex': /(dp\.pt\.)[a-z0-9]{43}/i
  },
  {
    'id': 'duffel-api-token',
    'regex': /duffel_(test|live)_[a-z0-9_\-=]{43}/i
  },
  {
    'id': 'dynatrace-api-token',
    'regex': /dt0c01\.[a-z0-9]{24}\.[a-z0-9]{64}/i
  },
  {
    'id': 'easypost-api-token',
    'regex': /\bEZAK[a-z0-9]{54}/i
  },
  {
    'id': 'flutterwave-public-key',
    'regex': /FLWPUBK_TEST-[a-h0-9]{32}-X/i
  },
  {
    'id': 'frameio-api-token',
    'regex': /fio-u-[a-z0-9\-_=]{64}/i
  },
  {
    'id': 'gcp-api-key',
    'regex': /\b(AIza[0-9a-z\-_]{35})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'github-app-token',
    'regex': /(ghu|ghs)_[0-9a-zA-Z]{36}/
  },
  {
    'id': 'github-fine-grained-pat',
    'regex': /github_pat_[0-9a-zA-Z_]{82}/
  },
  {
    'id': 'github-oauth',
    'regex': /gho_[0-9a-zA-Z]{36}/
  },
  {
    'id': 'github-pat',
    'regex': /ghp_[0-9a-zA-Z]{36}/
  },
  {
    'id': 'gitlab-pat',
    'regex': /glpat-[0-9a-zA-Z\-_]{20}/
  },
  {
    'id': 'gitlab-ptt',
    'regex': /glptt-[0-9a-f]{40}/
  },
  {
    'id': 'gitlab-rrt',
    'regex': /GR1348941[0-9a-zA-Z\-_]{20}/
  },
  {
    'id': 'grafana-api-key',
    'regex': /\b(eyJrIjoi[a-z0-9]{70,400}={0,2})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'grafana-cloud-api-token',
    'regex': /\b(glc_[a-z0-9+/]{32,400}={0,2})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'grafana-service-account-token',
    'regex': /\b(glsa_[a-z0-9]{32}_[a-f0-9]{8})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'hashicorp-tf-api-token',
    'regex': /[a-z0-9]{14}\.atlasv1\.[a-z0-9\-_=]{60,70}/i
  },
  {
    'id': 'jwt',
    'regex': /\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.(?:[a-zA-Z0-9/_-]{10,}={0,2})?)(?:['"\s\x60;]|$)/
  },
  {
    'id': 'linear-api-key',
    'regex': /lin_api_[a-z0-9]{40}/i
  },
  {
    'id': 'npm-access-token',
    'regex': /\b(npm_[a-z0-9]{36})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'openai-api-key',
    'regex': /\b(sk-[a-z0-9]{20}T3BlbkFJ[a-z0-9]{20})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'planetscale-api-token',
    'regex': /\b(pscale_tkn_[a-z0-9=\-_.]{32,64})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'planetscale-oauth-token',
    'regex': /\b(pscale_oauth_[a-z0-9=\-_.]{32,64})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'planetscale-password',
    'regex': /\b(pscale_pw_[a-z0-9=\-_.]{32,64})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'postman-api-token',
    'regex': /\b(PMAK-[a-f0-9]{24}-[a-f0-9]{34})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'prefect-api-token',
    'regex': /\b(pnu_[a-z0-9]{36})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'private-key',
    'regex': /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----[\s\S]*KEY( BLOCK)?----/i
  },
  {
    'id': 'pulumi-api-token',
    'regex': /\b(pul-[a-f0-9]{40})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'pypi-upload-token',
    'regex': /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9\-_]{50,1000}/
  },
  {
    'id': 'readme-api-token',
    'regex': /\b(rdme_[a-z0-9]{70})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'rubygems-api-token',
    'regex': /\b(rubygems_[a-f0-9]{48})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'scalingo-api-token',
    'regex': /tk-us-[a-zA-Z0-9-_]{48}/
  },
  {
    'id': 'sendgrid-api-token',
    'regex': /\b(SG\.[a-z0-9=_\-.]{66})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'sendinblue-api-token',
    'regex': /\b(xkeysib-[a-f0-9]{64}-[a-z0-9]{16})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'shippo-api-token',
    'regex': /\b(shippo_(live|test)_[a-f0-9]{40})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'shopify-access-token',
    'regex': /shpat_[a-fA-F0-9]{32}/
  },
  {
    'id': 'shopify-custom-access-token',
    'regex': /shpca_[a-fA-F0-9]{32}/
  },
  {
    'id': 'shopify-private-app-access-token',
    'regex': /shppa_[a-fA-F0-9]{32}/
  },
  {
    'id': 'shopify-shared-secret',
    'regex': /shpss_[a-fA-F0-9]{32}/
  },
  {
    'id': 'slack-app-token',
    'regex': /(xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+)/i
  },
  {
    'id': 'slack-bot-token',
    'regex': /(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)/
  },
  {
    'id': 'slack-config-access-token',
    'regex': /(xoxe.xox[bp]-\d-[A-Z0-9]{163,166})/i
  },
  {
    'id': 'slack-config-refresh-token',
    'regex': /(xoxe-\d-[A-Z0-9]{146})/i
  },
  {
    'id': 'slack-legacy-bot-token',
    'regex': /(xoxb-[0-9]{8,14}-[a-zA-Z0-9]{18,26})/
  },
  {
    'id': 'slack-legacy-token',
    'regex': /(xox[os]-\d+-\d+-\d+-[a-fA-F\d]+)/
  },
  {
    'id': 'slack-legacy-workspace-token',
    'regex': /(xox[ar]-(?:\d-)?[0-9a-zA-Z]{8,48})/
  },
  {
    'id': 'slack-user-token',
    'regex': /(xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34})/
  },
  {
    'id': 'slack-webhook-url',
    'regex': /(https?:\/\/)?hooks.slack.com\/(services|workflows)\/[A-Za-z0-9+/]{43,46}/
  },
  {
    'id': 'square-access-token',
    'regex': /\b(sq0atp-[0-9a-z\-_]{22})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'square-secret',
    'regex': /\b(sq0csp-[0-9a-z\-_]{43})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'stripe-access-token',
    'regex': /(sk|pk)_(test|live)_[0-9a-z]{10,32}/i
  },
  {
    'id': 'telegram-bot-api-token',
    'regex': /(?:^|[^0-9])([0-9]{5,16}:A[a-z0-9_-]{34})(?:$|[^a-z0-9_-])/i
  },
  {
    'id': 'twilio-api-key',
    'regex': /SK[0-9a-fA-F]{32}/
  },
  {
    'id': 'vault-batch-token',
    'regex': /\b(hvb\.[a-z0-9_-]{138,212})(?:['"\s\x60;]|$)/i
  },
  {
    'id': 'vault-service-token',
    'regex': /\b(hvs\.[a-z0-9_-]{90,100})(?:['"\s\x60;]|$)/i
  }
]
