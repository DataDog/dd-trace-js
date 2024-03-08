/* eslint-disable max-len */
'use strict'

module.exports = [
  {
    'id': 'adafruit-api-key',
    'regex': /(?:adafruit)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9_-]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'adobe-client-id',
    'regex': /(?:adobe)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-f0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'adobe-client-secret',
    'regex': /\b((p8e-)[a-z0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
<<<<<<< HEAD
    id: 'age-secret-key',
    regex: /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'age-secret-key',
    'regex': /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/
=======
    'id': 'age-secret-key',
    'regex': /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
    'id': 'airtable-api-key',
    'regex': /(?:airtable)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{17})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'algolia-api-key',
    'regex': /(?:algolia)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'alibaba-access-key-id',
    'regex': /\b((LTAI)[a-z0-9]{20})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'asana-client-id',
    'regex': /(?:asana)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9]{16})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'asana-client-secret',
    'regex': /(?:asana)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'atlassian-api-token',
    'regex': /(?:atlassian|confluence|jira)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{24})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'authress-service-client-access-key',
    'regex': /\b((?:sc|ext|scauth|authress)_[a-z0-9]{5,30}\.[a-z0-9]{4,6}\.acc[_-][a-z0-9-]{10,32}\.[a-z0-9+/_=-]{30,120})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
<<<<<<< HEAD
    id: 'aws-access-token',
    regex: /\b((A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16})(?:['"\s\x60;]|$)/
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'aws-access-token',
    'regex': /\b((A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16})(?:['"\s\x60;]|$)/
=======
    'id': 'aws-access-token',
    'regex': /\b((A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16})(?:['"\s\x60;]|$)/,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
    'id': 'beamer-api-token',
    'regex': /(?:beamer)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(b_[a-z0-9=_-]{44})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'bitbucket-client-id',
    'regex': /(?:bitbucket)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'bitbucket-client-secret',
    'regex': /(?:bitbucket)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9=_-]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'bittrex-access-key',
    'regex': /(?:bittrex)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'clojars-api-token',
    'regex': /(CLOJARS_)[a-z0-9]{60}/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'codecov-access-token',
    'regex': /(?:codecov)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'coinbase-access-token',
    'regex': /(?:coinbase)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9_-]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'confluent-access-token',
    'regex': /(?:confluent)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{16})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'confluent-secret-key',
    'regex': /(?:confluent)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'contentful-delivery-api-token',
    'regex': /(?:contentful)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9=_-]{43})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'databricks-api-token',
    'regex': /\b(dapi[a-h0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'datadog-access-token',
    'regex': /(?:datadog)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{40})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'defined-networking-api-token',
    'regex': /(?:dnkey)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(dnkey-[a-z0-9=_-]{26}-[a-z0-9=_-]{52})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'digitalocean-access-token',
    'regex': /\b(doo_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
<<<<<<< HEAD
    id: 'digitalocean-pat',
    regex: /\b(dop_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'digitalocean-pat',
    'regex': /\b(dop_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i
=======
    'id': 'digitalocean-pat',
    'regex': /\b(dop_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'digitalocean-refresh-token',
    regex: /\b(dor_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'digitalocean-refresh-token',
    'regex': /\b(dor_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i
=======
    'id': 'digitalocean-refresh-token',
    'regex': /\b(dor_v1_[a-f0-9]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
    'id': 'discord-api-token',
    'regex': /(?:discord)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-f0-9]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'discord-client-id',
    'regex': /(?:discord)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9]{18})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'discord-client-secret',
    'regex': /(?:discord)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9=_-]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'doppler-api-token',
    'regex': /(dp\.pt\.)[a-z0-9]{43}/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'droneci-access-token',
    'regex': /(?:droneci)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'dropbox-api-token',
    'regex': /(?:dropbox)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{15})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'dropbox-long-lived-api-token',
    'regex': /(?:dropbox)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{11}(AAAAAAAAAA)[a-z0-9\-_=]{43})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'dropbox-short-lived-api-token',
    'regex': /(?:dropbox)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(sl\.[a-z0-9\-=_]{135})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'duffel-api-token',
    'regex': /duffel_(test|live)_[a-z0-9_\-=]{43}/i,
    'mode': 'ValueOnly'
  },
  {
<<<<<<< HEAD
    id: 'dynatrace-api-token',
    regex: /dt0c01\.[a-z0-9]{24}\.[a-z0-9]{64}/i
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'dynatrace-api-token',
    'regex': /dt0c01\.[a-z0-9]{24}\.[a-z0-9]{64}/i
=======
    'id': 'dynatrace-api-token',
    'regex': /dt0c01\.[a-z0-9]{24}\.[a-z0-9]{64}/i,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'easypost-api-token',
    regex: /\bEZAK[a-z0-9]{54}/i
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'easypost-api-token',
    'regex': /\bEZAK[a-z0-9]{54}/i
=======
    'id': 'easypost-api-token',
    'regex': /\bEZAK[a-z0-9]{54}/i,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
    'id': 'etsy-access-token',
    'regex': /(?:etsy)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{24})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'facebook',
    'regex': /(?:facebook)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-f0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'fastly-api-token',
    'regex': /(?:fastly)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9=_-]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'finicity-api-token',
    'regex': /(?:finicity)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-f0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'finicity-client-secret',
    'regex': /(?:finicity)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{20})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'finnhub-access-token',
    'regex': /(?:finnhub)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{20})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'flickr-access-token',
    'regex': /(?:flickr)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'flutterwave-public-key',
    'regex': /FLWPUBK_TEST-[a-h0-9]{32}-X/i,
    'mode': 'ValueOnly'
  },
  {
<<<<<<< HEAD
    id: 'frameio-api-token',
    regex: /fio-u-[a-z0-9\-_=]{64}/i
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'frameio-api-token',
    'regex': /fio-u-[a-z0-9\-_=]{64}/i
=======
    'id': 'frameio-api-token',
    'regex': /fio-u-[a-z0-9\-_=]{64}/i,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
    'id': 'freshbooks-access-token',
    'regex': /(?:freshbooks)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'gcp-api-key',
    'regex': /\b(AIza[0-9a-z\-_]{35})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
<<<<<<< HEAD
    id: 'github-app-token',
    regex: /(ghu|ghs)_[0-9a-zA-Z]{36}/
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'github-app-token',
    'regex': /(ghu|ghs)_[0-9a-zA-Z]{36}/
=======
    'id': 'github-app-token',
    'regex': /(ghu|ghs)_[0-9a-zA-Z]{36}/,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'github-fine-grained-pat',
    regex: /github_pat_[0-9a-zA-Z_]{82}/
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'github-fine-grained-pat',
    'regex': /github_pat_[0-9a-zA-Z_]{82}/
=======
    'id': 'github-fine-grained-pat',
    'regex': /github_pat_[0-9a-zA-Z_]{82}/,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'github-oauth',
    regex: /gho_[0-9a-zA-Z]{36}/
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'github-oauth',
    'regex': /gho_[0-9a-zA-Z]{36}/
=======
    'id': 'github-oauth',
    'regex': /gho_[0-9a-zA-Z]{36}/,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'github-pat',
    regex: /ghp_[0-9a-zA-Z]{36}/
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'github-pat',
    'regex': /ghp_[0-9a-zA-Z]{36}/
=======
    'id': 'github-pat',
    'regex': /ghp_[0-9a-zA-Z]{36}/,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'gitlab-pat',
    regex: /glpat-[0-9a-zA-Z\-_]{20}/
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'gitlab-pat',
    'regex': /glpat-[0-9a-zA-Z\-_]{20}/
=======
    'id': 'gitlab-pat',
    'regex': /glpat-[0-9a-zA-Z\-_]{20}/,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'gitlab-ptt',
    regex: /glptt-[0-9a-f]{40}/
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'gitlab-ptt',
    'regex': /glptt-[0-9a-f]{40}/
=======
    'id': 'gitlab-ptt',
    'regex': /glptt-[0-9a-f]{40}/,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'gitlab-rrt',
    regex: /GR1348941[0-9a-zA-Z\-_]{20}/
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'gitlab-rrt',
    'regex': /GR1348941[0-9a-zA-Z\-_]{20}/
=======
    'id': 'gitlab-rrt',
    'regex': /GR1348941[0-9a-zA-Z\-_]{20}/,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
    'id': 'gitter-access-token',
    'regex': /(?:gitter)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9_-]{40})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'gocardless-api-token',
    'regex': /(?:gocardless)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(live_[a-z0-9\-_=]{40})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'grafana-api-key',
    'regex': /\b(eyJrIjoi[a-z0-9]{70,400}={0,2})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
<<<<<<< HEAD
    id: 'grafana-cloud-api-token',
    regex: /\b(glc_[a-z0-9+/]{32,400}={0,2})(?:['"\s\x60;]|$)/i
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'grafana-cloud-api-token',
    'regex': /\b(glc_[a-z0-9+/]{32,400}={0,2})(?:['"\s\x60;]|$)/i
=======
    'id': 'grafana-cloud-api-token',
    'regex': /\b(glc_[a-z0-9+/]{32,400}={0,2})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'grafana-service-account-token',
    regex: /\b(glsa_[a-z0-9]{32}_[a-f0-9]{8})(?:['"\s\x60;]|$)/i
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'grafana-service-account-token',
    'regex': /\b(glsa_[a-z0-9]{32}_[a-f0-9]{8})(?:['"\s\x60;]|$)/i
=======
    'id': 'grafana-service-account-token',
    'regex': /\b(glsa_[a-z0-9]{32}_[a-f0-9]{8})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
<<<<<<< HEAD
    id: 'hashicorp-tf-api-token',
    regex: /[a-z0-9]{14}\.atlasv1\.[a-z0-9\-_=]{60,70}/i
||||||| parent of 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
    'id': 'hashicorp-tf-api-token',
    'regex': /[a-z0-9]{14}\.atlasv1\.[a-z0-9\-_=]{60,70}/i
=======
    'id': 'hashicorp-tf-api-token',
    'regex': /[a-z0-9]{14}\.atlasv1\.[a-z0-9\-_=]{60,70}/i,
    'mode': 'ValueOnly'
>>>>>>> 5683fb010 (Include a rule mode to differenciate between ValueOnly rules and NameAndValue rules)
  },
  {
    'id': 'heroku-api-key',
    'regex': /(?:heroku)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'hubspot-api-key',
    'regex': /(?:hubspot)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'intercom-api-key',
    'regex': /(?:intercom)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9=_-]{60})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'jfrog-api-key',
    'regex': /(?:jfrog|artifactory|bintray|xray)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{73})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'jwt',
    'regex': /\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.(?:[a-zA-Z0-9/_-]{10,}={0,2})?)(?:['"\s\x60;]|$)/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'kraken-access-token',
    'regex': /(?:kraken)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9/=_+-]{80,90})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'kucoin-access-token',
    'regex': /(?:kucoin)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-f0-9]{24})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'launchdarkly-access-token',
    'regex': /(?:launchdarkly)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9=_-]{40})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'linear-api-key',
    'regex': /lin_api_[a-z0-9]{40}/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'linkedin-client-secret',
    'regex': /(?:linkedin|linked-in)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{16})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'lob-pub-api-key',
    'regex': /(?:lob)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}((test|live)_pub_[a-f0-9]{31})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'mailchimp-api-key',
    'regex': /(?:mailchimp)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-f0-9]{32}-us20)(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'mailgun-private-api-token',
    'regex': /(?:mailgun)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(key-[a-f0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'mailgun-pub-key',
    'regex': /(?:mailgun)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(pubkey-[a-f0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'mailgun-signing-key',
    'regex': /(?:mailgun)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-h0-9]{32}-[a-h0-9]{8}-[a-h0-9]{8})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'mapbox-api-token',
    'regex': /(?:mapbox)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(pk\.[a-z0-9]{60}\.[a-z0-9]{22})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'mattermost-access-token',
    'regex': /(?:mattermost)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{26})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'messagebird-api-token',
    'regex': /(?:messagebird|message-bird|message_bird)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{25})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'netlify-access-token',
    'regex': /(?:netlify)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9=_-]{40,46})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'new-relic-browser-api-token',
    'regex': /(?:new-relic|newrelic|new_relic)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(NRJS-[a-f0-9]{19})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'new-relic-user-api-id',
    'regex': /(?:new-relic|newrelic|new_relic)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'new-relic-user-api-key',
    'regex': /(?:new-relic|newrelic|new_relic)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(NRAK-[a-z0-9]{27})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'npm-access-token',
    'regex': /\b(npm_[a-z0-9]{36})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'nytimes-access-token',
    'regex': /(?:nytimes|new-york-times,|newyorktimes)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9=_-]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'okta-access-token',
    'regex': /(?:okta)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9=_-]{42})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'openai-api-key',
    'regex': /\b(sk-[a-z0-9]{20}T3BlbkFJ[a-z0-9]{20})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'plaid-api-token',
    'regex': /(?:plaid)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(access-(?:sandbox|development|production)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'plaid-client-id',
    'regex': /(?:plaid)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{24})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'plaid-secret-key',
    'regex': /(?:plaid)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{30})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'planetscale-api-token',
    'regex': /\b(pscale_tkn_[a-z0-9=\-_.]{32,64})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'planetscale-oauth-token',
    'regex': /\b(pscale_oauth_[a-z0-9=\-_.]{32,64})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'planetscale-password',
    'regex': /\b(pscale_pw_[a-z0-9=\-_.]{32,64})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'postman-api-token',
    'regex': /\b(PMAK-[a-f0-9]{24}-[a-f0-9]{34})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'prefect-api-token',
    'regex': /\b(pnu_[a-z0-9]{36})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'private-key',
    'regex': /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----[\s\S]*KEY( BLOCK)?----/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'pulumi-api-token',
    'regex': /\b(pul-[a-f0-9]{40})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'pypi-upload-token',
    'regex': /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9\-_]{50,1000}/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'rapidapi-access-token',
    'regex': /(?:rapidapi)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9_-]{50})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'readme-api-token',
    'regex': /\b(rdme_[a-z0-9]{70})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'rubygems-api-token',
    'regex': /\b(rubygems_[a-f0-9]{48})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'scalingo-api-token',
    'regex': /tk-us-[a-zA-Z0-9-_]{48}/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'sendbird-access-id',
    'regex': /(?:sendbird)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'sendbird-access-token',
    'regex': /(?:sendbird)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-f0-9]{40})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'sendgrid-api-token',
    'regex': /\b(SG\.[a-z0-9=_\-.]{66})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'sendinblue-api-token',
    'regex': /\b(xkeysib-[a-f0-9]{64}-[a-z0-9]{16})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'sentry-access-token',
    'regex': /(?:sentry)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-f0-9]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'shippo-api-token',
    'regex': /\b(shippo_(live|test)_[a-f0-9]{40})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'shopify-access-token',
    'regex': /shpat_[a-fA-F0-9]{32}/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'shopify-custom-access-token',
    'regex': /shpca_[a-fA-F0-9]{32}/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'shopify-private-app-access-token',
    'regex': /shppa_[a-fA-F0-9]{32}/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'shopify-shared-secret',
    'regex': /shpss_[a-fA-F0-9]{32}/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'sidekiq-secret',
    'regex': /(?:BUNDLE_ENTERPRISE__CONTRIBSYS__COM|BUNDLE_GEMS__CONTRIBSYS__COM)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-f0-9]{8}:[a-f0-9]{8})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'slack-app-token',
    'regex': /(xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'slack-bot-token',
    'regex': /(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'slack-config-access-token',
    'regex': /(xoxe.xox[bp]-\d-[A-Z0-9]{163,166})/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'slack-config-refresh-token',
    'regex': /(xoxe-\d-[A-Z0-9]{146})/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'slack-legacy-bot-token',
    'regex': /(xoxb-[0-9]{8,14}-[a-zA-Z0-9]{18,26})/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'slack-legacy-token',
    'regex': /(xox[os]-\d+-\d+-\d+-[a-fA-F\d]+)/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'slack-legacy-workspace-token',
    'regex': /(xox[ar]-(?:\d-)?[0-9a-zA-Z]{8,48})/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'slack-user-token',
    'regex': /(xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34})/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'slack-webhook-url',
    'regex': /(https?:\/\/)?hooks.slack.com\/(services|workflows)\/[A-Za-z0-9+/]{43,46}/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'snyk-api-token',
    'regex': /(?:snyk)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'square-access-token',
    'regex': /\b(sq0atp-[0-9a-z\-_]{22})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'square-secret',
    'regex': /\b(sq0csp-[0-9a-z\-_]{43})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'squarespace-access-token',
    'regex': /(?:squarespace)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'stripe-access-token',
    'regex': /(sk|pk)_(test|live)_[0-9a-z]{10,32}/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'sumologic-access-token',
    'regex': /(?:sumo)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{64})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'telegram-bot-api-token',
    'regex': /(?:^|[^0-9])([0-9]{5,16}:A[a-z0-9_-]{34})(?:$|[^a-z0-9_-])/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'travisci-access-token',
    'regex': /(?:travis)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{22})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'trello-access-token',
    'regex': /(?:trello)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z-0-9]{32})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'twilio-api-key',
    'regex': /SK[0-9a-fA-F]{32}/,
    'mode': 'ValueOnly'
  },
  {
    'id': 'twitch-api-token',
    'regex': /(?:twitch)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{30})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'twitter-access-secret',
    'regex': /(?:twitter)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{45})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'twitter-access-token',
    'regex': /(?:twitter)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9]{15,25}-[a-z0-9]{20,40})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'twitter-api-key',
    'regex': /(?:twitter)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{25})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'twitter-api-secret',
    'regex': /(?:twitter)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{50})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'twitter-bearer-token',
    'regex': /(?:twitter)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(A{22}[a-z0-9%]{80,100})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'typeform-api-token',
    'regex': /(?:typeform)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(tfp_[a-z0-9\-_.=]{59})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'vault-batch-token',
    'regex': /\b(hvb\.[a-z0-9_-]{138,212})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'vault-service-token',
    'regex': /\b(hvs\.[a-z0-9_-]{90,100})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  },
  {
    'id': 'yandex-access-token',
    'regex': /(?:yandex)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(t1\.[A-Z0-9a-z_-]+[=]{0,2}\.[A-Z0-9a-z_-]{86}[=]{0,2})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'yandex-api-key',
    'regex': /(?:yandex)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(AQVN[a-z0-9_-]{35,38})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'yandex-aws-access-token',
    'regex': /(?:yandex)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}(YC[a-z0-9_-]{38})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'zendesk-secret-key',
    'regex': /(?:zendesk)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([a-z0-9]{40})(?:['"\s\x60;]|$)/i,
    'mode': 'NameAndValue'
  },
  {
    'id': 'generic-api-key',
    'regex': /(?:hashpwd|passphrase|password|passw|secret|passkey|pass|pwd|pswd|passwd)(?:[0-9a-z\-_\t.]{0,20})(?:[\s|']|[\s|""]){0,3}(?:=|>|:{1,3}=|\|\|:|<=|=>|:|\?=)(?:'|""|\s|=|\x60){0,5}([0-9a-z\-_.=]{10,150})(?:['"\s\x60;]|$)/i,
    'mode': 'ValueOnly'
  }
]
