import cheerio from 'cheerio';
import {promises as fs} from 'fs';
import {AllHtmlEntities} from 'html-entities';
import * as moment from 'moment';
import {join} from 'path';
import request, {CoreOptions, RequiredUriUrl, Response} from 'request';
import {
  CACHE_DIR,
  DATA_DEFAULT,
  DATA_DOCUMENTS,
  DATA_PARSED_JSON,
  DATA_RAW_JSON,
  DATA_TERMS,
  EXTRACT_WORDS_FN,
  FIELDS,
  SEARCH_RESULTS_MAX,
} from '../const';
import {Job, Results} from './model';
import {Queue} from './queue';

const entities = new AllHtmlEntities();

const DDO_BEFORE = 'phApp.ddo = ';
const DDO_AFTER = '; phApp.sessionParams';
const FETCH_JITTER = 1000;
const MAX_RETRIES = 5;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const distinct = <T, K> (values: T[], key: (val: T) => K): T[] => {
  const seen = new Set<K>();
  return values.filter(v => {
    const k = key(v);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
};

const req = (params: CoreOptions & RequiredUriUrl): Promise<Response> => new Promise((resolve, reject) => request(params, (error, response) => {
  if (error) {
    reject(error);
  } else if (response.statusCode >= 500) {
    reject(Object.assign(new Error(`Server error (status ${response.statusCode}) while fetching ${response.request.href}`), {
      statusCode: response.statusCode,
      response,
    }));
  } else {
    resolve(response);
  }
}));

const fetchDdo = async <O extends object> (uri: string, qs?: { [name: string]: string | number }): Promise<O | null> => {
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    await wait(Math.floor(Math.random() * FETCH_JITTER));
    let response: Response;
    try {
      response = await req({
        uri,
        qs,
        headers: {
          // User agent is required, as otherwise the page responds with an error.
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.113 Safari/537.36',
        },
        timeout: 30000,
      });
    } catch (error) {
      console.warn(`Attempt ${retry} failed with error:`);
      console.warn(error.message);
      continue;
    }

    // Job could be missing (404), gone (410), etc.
    if (response.statusCode < 400) {
      const $ = cheerio.load(response.body);
      for (const $script of $('script').get()) {
        const js = $($script).contents().text();
        const start = js.indexOf(DDO_BEFORE);
        if (start == -1) {
          continue;
        }
        return JSON.parse(js.slice(start + DDO_BEFORE.length, js.indexOf(DDO_AFTER, start)));
      }
      // If data isn't found in any <script>, return null.
    }
    break;
  }
  return null;
};

const jsonFromCache = async <V> (cachePath: string, computeFn: () => Promise<V>): Promise<V> => {
  try {
    return JSON.parse(await fs.readFile(cachePath, 'utf8'));
  } catch (e) {
    if (e.code != 'ENOENT') {
      throw e;
    }
    const value = await computeFn();
    await fs.writeFile(cachePath, JSON.stringify(value));
    return value;
  }
};

const fetchJobDescription = async (id: string | number): Promise<string> => {
  const job = await jsonFromCache<Job>(join(CACHE_DIR, `job${id}.json`), async () => {
    const ddo = await fetchDdo<any>(`https://careers.microsoft.com/professionals/us/en/job/${id}/`);
    return ddo?.jobDetail?.data?.job;
  });
  return job == undefined
    ? ''
    : cheerio(`<div>${[job.description, job.jobSummary, job.jobResponsibilities, job.jobQualifications].join('')}</div>`).text();
};

const fetchResults = async (from: number): Promise<Results> =>
  jsonFromCache<Results>(join(CACHE_DIR, `results${from}.json`), async () => {
    const ddo = await fetchDdo<any>(`https://careers.microsoft.com/us/en/search-results`, {
      from,
      s: 1, // This is required, otherwise `from` is ignored.
      rt: 'professional', // Professional jobs.
    });
    return ddo.eagerLoadRefineSearch;
  });

const queue = new Queue(8);

const loadRaw = async () =>
  jsonFromCache(join(DATA_RAW_JSON), async () => {
    const first = await fetchResults(0);
    const pagination = first.hits;
    const total = first.totalHits;

    console.info(`Need to retrieve ${total} jobs in chunks of ${pagination}`);

    const results = await Promise.all(
      Array.from(
        {length: Math.ceil(total / pagination)},
        (_, i) => queue.queue(() => fetchResults(i * pagination)),
      ),
    );

    const jobs = distinct(
      results.flatMap(result => result.data.jobs),
      j => j.jobId,
    );

    const fullDescriptions = await Promise.all(jobs.map(j => queue.queue(() => fetchJobDescription(j.jobId))));

    return jobs.map((j, i) => ({
      ...j,
      fullDescription: fullDescriptions[i] || j.descriptionTeaser,
    }));
  });

const parse = (rawData: any[]) =>
  rawData
    .sort((a, b) => b.postedDate.localeCompare(a.postedDate))
    .map(j => ({
      ID: j.jobId,
      title: j.title,
      date: moment.utc(j.postedDate).format('YYYY-M-D'),
      location: j.location,
      preview: entities.decode(j.descriptionTeaser),
      description: entities.decode(j.fullDescription),
    }));

const withShortDescription = (j: any) => ({
  ...j,
  preview: undefined,
  description: j.preview,
});

(async () => {
  const raw = await loadRaw();
  console.info('Successfully retrieved data');

  const parsed = await parse(raw);
  await fs.writeFile(DATA_PARSED_JSON, JSON.stringify(parsed));
  await fs.writeFile(DATA_DEFAULT, JSON.stringify(parsed.slice(0, SEARCH_RESULTS_MAX).map(withShortDescription)));

  const contents = parsed.map(j => JSON.stringify(withShortDescription(j)) + '\0').join('');
  const terms = parsed.map(job =>
    FIELDS
      // For each field, get words from that field's value and map to the form `{field}_{term}\0`.
      .map(f => [...new Set(EXTRACT_WORDS_FN(job[f]).map(t => `${f}_${t}\0`))])
      .flat(Infinity)
      .join('') + '\0',
  ).join('');
  await fs.writeFile(DATA_DOCUMENTS, contents);
  await fs.writeFile(DATA_TERMS, terms);
})()
  .catch(e => {
    if (e.statusCode != undefined) {
      console.error(`Failed to fetch ${e.response.request.href} with status ${e.statusCode}`);
    } else {
      console.error(e);
    }
  });
