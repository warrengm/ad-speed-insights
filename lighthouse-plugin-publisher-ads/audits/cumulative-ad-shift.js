// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const i18n = require('lighthouse/lighthouse-core/lib/i18n/i18n');
const {auditNotApplicable} = require('../messages/common-strings');
const {Audit} = require('lighthouse');
const {getScriptUrl} = require('../utils/network-timing');
const {isAdIframe, isImplTag} = require('../utils/resource-classification');
const {overlaps, toClientRect} = require('../utils/geometry');

const UIStrings = {
  title: 'Cumulative ad shift',
  failureTitle: 'Reduce ad-related layout shift',
  description:
      'Measures [layout shifts](https://web.dev/cls) that were ' +
          'caused by ads or happened near ads. Reducing cumulative ad shift ' +
          'will improve user experience. For more information about ' +
          'minimizing layout shift in GPT, [visit the developer reference]' +
          '(https://developers.google.com/doubleclick-gpt/guides/minimize-layout-shift)',
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);

/**
 * Audit to determine time for first ad request relative to page start.
 */
class CumulativeAdShift extends Audit {
  /**
   * @return {LH.Audit.Meta}
   * @override
   */
  static get meta() {
    return {
      id: 'cumulative-ad-shift',
      title: str_(UIStrings.title),
      failureTitle: str_(UIStrings.failureTitle),
      description: str_(UIStrings.description),
      // @ts-ignore
      scoreDisplayMode: Audit.SCORING_MODES.NUMERIC,
      requiredArtifacts: ['traces', 'IFrameElements'],
    };
  }

  /**
   * @return {LH.Audit.ScoreOptions}
   */
  static get defaultOptions() {
    // TODO tune this
    return {
      p10: 0.05,
      median: 0.25,
    };
  }

  /**
   * @param {LH.TraceEvent} shiftEvent
   * @param {Artifacts['IFrameElement'][]} ads
   */
  static isAdShift(shiftEvent, ads) {
    if (!shiftEvent.args || !shiftEvent.args.data) {
      return false;
    }
    for (const ad of ads) {
      // Names come from external JSON
      // eslint-disable-next-line camelcase
      for (const node of shiftEvent.args.data.impacted_nodes || []) {
        // eslint-disable-next-line camelcase
        const /* number[] */ oldRect = node.old_rect || [];
        const shiftRect = toClientRect(oldRect);
        const adRect = ad.clientRect;
        if (overlaps(shiftRect, adRect)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Computes the ad shift score for the page.
   * @param {LH.TraceEvent[]} shiftEvents
   * @param {Artifacts['IFrameElement'][]} ads
   * @param {number} tagLoadTs
   */
  static compute(shiftEvents, ads, tagLoadTs) {
    let cumulativeShift = 0;
    let numShifts = 0;
    let cumulativeAdShift = 0;
    let numAdShifts = 0;
    let cumulativePreImplTagAdShift = 0;
    let numPreImplTagAdShifts = 0;
    for (const event of shiftEvents) {
      if (!event.args || !event.args.data || !event.args.data.is_main_frame ||
         // Should remove the had_recent_input check after Lighthouse 6.2 is
         // released.
         // @ts-ignore Sometimes the initial navigation counts as recent input.
         event.args.data.had_recent_input) {
        continue;
      }
      // @ts-ignore
      cumulativeShift += event.args.data.score;
      numShifts++;
      if (this.isAdShift(event, ads)) {
        // @ts-ignore
        cumulativeAdShift += event.args.data.score;
        numAdShifts++;
        if (event.ts < tagLoadTs) {
          // @ts-ignore
          cumulativePreImplTagAdShift += event.args.data.score;
          numPreImplTagAdShifts++;
        }
      }
    }
    return {
      cumulativeShift,
      numShifts,
      cumulativeAdShift,
      numAdShifts,
      cumulativePreImplTagAdShift,
      numPreImplTagAdShifts,
    };
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static async audit(artifacts, context) {
    const trace = artifacts.traces[Audit.DEFAULT_PASS];
    const shiftEvents =
      trace.traceEvents.filter((e) => e.name === 'LayoutShift');
    if (!shiftEvents.length) {
      return auditNotApplicable.NoLayoutShifts;
    }

    const tagLoadEvent =
        trace.traceEvents.find((e) => isImplTag(getScriptUrl(e) || '')) ||
        {ts: Infinity};

    // Maybe we should look at the parent elements (created by the publisher and
    // passed to the ad tag) rather than the iframe itself.
    const ads = artifacts.IFrameElements.filter(isAdIframe);
    if (!ads.length) {
      // TODO count shifts for the container element here.
      return auditNotApplicable.NoAdRendered;
    }

    const details = this.compute(shiftEvents, ads, tagLoadEvent.ts);
    const rawScore = details.cumulativeAdShift;
    return {
      numericValue: rawScore,
      numericUnit: 'unitless',
      score: Audit.computeLogNormalScore(context.options, rawScore),
      displayValue: rawScore.toLocaleString(context.settings.locale),
      // @ts-ignore Add more fields for logging
      details,
    };
  }
}

module.exports = CumulativeAdShift;
module.exports.UIStrings = UIStrings;
