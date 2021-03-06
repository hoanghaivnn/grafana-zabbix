import _ from 'lodash';
import * as dateMath from 'app/core/utils/datemath';
import * as utils from './utils';
import * as migrations from './migrations';
import * as metricFunctions from './metricFunctions';
import * as c from './constants';
import dataProcessor from './dataProcessor';
import responseHandler from './responseHandler';
import './zabbix.js';
import './zabbixAlerting.service.js';
import {ZabbixAPIError} from './zabbixAPICore.service.js';

class ZabbixAPIDatasource {

  /** @ngInject */
  constructor(instanceSettings, templateSrv, alertSrv, dashboardSrv, zabbixAlertingSrv, Zabbix) {
    this.templateSrv = templateSrv;
    this.alertSrv = alertSrv;
    this.dashboardSrv = dashboardSrv;
    this.zabbixAlertingSrv = zabbixAlertingSrv;

    // General data source settings
    this.name             = instanceSettings.name;
    this.url              = instanceSettings.url;
    this.basicAuth        = instanceSettings.basicAuth;
    this.withCredentials  = instanceSettings.withCredentials;

    // Zabbix API credentials
    this.username         = instanceSettings.jsonData.username;
    this.password         = instanceSettings.jsonData.password;

    // Use trends instead history since specified time
    this.trends           = instanceSettings.jsonData.trends;
    this.trendsFrom       = instanceSettings.jsonData.trendsFrom || '7d';
    this.trendsRange      = instanceSettings.jsonData.trendsRange || '4d';

    // Set cache update interval
    var ttl = instanceSettings.jsonData.cacheTTL || '1h';
    this.cacheTTL = utils.parseInterval(ttl);

    // Alerting options
    this.alertingEnabled = instanceSettings.jsonData.alerting;
    this.addThresholds = instanceSettings.jsonData.addThresholds;
    this.alertingMinSeverity = instanceSettings.jsonData.alertingMinSeverity || c.SEV_WARNING;

    this.zabbix = new Zabbix(this.url, this.username, this.password, this.basicAuth, this.withCredentials, this.cacheTTL);

    // Use custom format for template variables
    this.replaceTemplateVars = _.partial(replaceTemplateVars, this.templateSrv);
  }

  ////////////////////////
  // Datasource methods //
  ////////////////////////

  /**
   * Query panel data. Calls for each panel in dashboard.
   * @param  {Object} options   Contains time range, targets and other info.
   * @return {Object} Grafana metrics object with timeseries data for each target.
   */
  query(options) {
    // Get alerts for current panel
    if (this.alertingEnabled) {
      this.alertQuery(options).then(alert => {
        this.zabbixAlertingSrv.setPanelAlertState(options.panelId, alert.state);

        this.zabbixAlertingSrv.removeZabbixThreshold(options.panelId);
        if (this.addThresholds) {
          _.forEach(alert.thresholds, threshold => {
            this.zabbixAlertingSrv.setPanelThreshold(options.panelId, threshold);
          });
        }
      });
    }

    // Create request for each target
    let promises = _.map(options.targets, t => {
      let timeFrom = Math.ceil(dateMath.parse(options.range.from) / 1000);
      let timeTo = Math.ceil(dateMath.parse(options.range.to) / 1000);

      // Prevent changes of original object
      let target = _.cloneDeep(t);
      this.replaceTargetVariables(target, options);

      // Apply Time-related functions (timeShift(), etc)
      let timeFunctions = bindFunctionDefs(target.functions, 'Time');
      if (timeFunctions.length) {
        const [time_from, time_to] = sequence(timeFunctions)([timeFrom, timeTo]);
        timeFrom = time_from;
        timeTo = time_to;
      }
      let timeRange = [timeFrom, timeTo];

      let useTrends = this.isUseTrends(timeRange);

      // Metrics or Text query mode
      if (target.mode !== c.MODE_ITSERVICE) {
        // Migrate old targets
        target = migrations.migrate(target);

        // Don't request undefined and hidden targets
        if (target.hide || !target.group || !target.host || !target.item) {
          return [];
        }

        if (!target.mode || target.mode === c.MODE_METRICS) {
          return this.queryNumericData(target, timeRange, useTrends);
        } else if (target.mode === c.MODE_TEXT) {
          return this.queryTextData(target, timeRange);
        }
      }

      // IT services mode
      else if (target.mode === c.MODE_ITSERVICE) {
        // Don't show undefined and hidden targets
        if (target.hide || !target.itservice || !target.slaProperty) {
          return [];
        }

        return this.zabbix.getSLA(target.itservice.serviceid, timeRange)
        .then(slaObject => {
          return responseHandler.handleSLAResponse(target.itservice, target.slaProperty, slaObject);
        });
      }
    });

    // Data for panel (all targets)
    return Promise.all(_.flatten(promises))
      .then(_.flatten)
      .then(timeseries_data => {
        return downsampleSeries(timeseries_data, options);
      })
      .then(data => {
        return { data: data };
      });
  }

  queryNumericData(target, timeRange, useTrends) {
    let [timeFrom, timeTo] = timeRange;
    let options = {
      itemtype: 'num'
    };
    return this.zabbix.getItemsFromTarget(target, options)
    .then(items => {
      let getHistoryPromise;

      if (useTrends) {
        let valueType = this.getTrendValueType(target);
        getHistoryPromise = this.zabbix.getTrend(items, timeFrom, timeTo)
        .then(history => {
          return responseHandler.handleTrends(history, items, valueType);
        })
        .then(timeseries => {
          // Sort trend data, issue #202
          _.forEach(timeseries, series => {
            series.datapoints = _.sortBy(series.datapoints, point => point[c.DATAPOINT_TS]);
          });

          return timeseries;
        });
      } else {
        // Use history
        getHistoryPromise = this.zabbix.getHistory(items, timeFrom, timeTo)
        .then(history => {
          return responseHandler.handleHistory(history, items);
        });
      }

      return getHistoryPromise.then(timeseries_data => {
        return this.applyDataProcessingFunctions(timeseries_data, target);
      });
    })
    .catch(error => {
      console.log(error);
      return [];
    });
  }

  getTrendValueType(target) {
    // Find trendValue() function and get specified trend value
    var trendFunctions = _.map(metricFunctions.getCategories()['Trends'], 'name');
    var trendValueFunc = _.find(target.functions, func => {
      return _.includes(trendFunctions, func.def.name);
    });
    return trendValueFunc ? trendValueFunc.params[0] : "avg";
  }

  applyDataProcessingFunctions(timeseries_data, target) {
    let transformFunctions   = bindFunctionDefs(target.functions, 'Transform');
    let aggregationFunctions = bindFunctionDefs(target.functions, 'Aggregate');
    let filterFunctions      = bindFunctionDefs(target.functions, 'Filter');
    let aliasFunctions       = bindFunctionDefs(target.functions, 'Alias');

    // Apply transformation functions
    timeseries_data = _.map(timeseries_data, timeseries => {
      timeseries.datapoints = sequence(transformFunctions)(timeseries.datapoints);
      return timeseries;
    });

    // Apply filter functions
    if (filterFunctions.length) {
      timeseries_data = sequence(filterFunctions)(timeseries_data);
    }

    // Apply aggregations
    if (aggregationFunctions.length) {
      let dp = _.map(timeseries_data, 'datapoints');
      dp = sequence(aggregationFunctions)(dp);

      let aggFuncNames = _.map(metricFunctions.getCategories()['Aggregate'], 'name');
      let lastAgg = _.findLast(target.functions, func => {
        return _.includes(aggFuncNames, func.def.name);
      });

      timeseries_data = [{
        target: lastAgg.text,
        datapoints: dp
      }];
    }

    // Apply alias functions
    _.forEach(timeseries_data, sequence(aliasFunctions));

    // Apply Time-related functions (timeShift(), etc)
    // Find timeShift() function and get specified trend value
    this.applyTimeShiftFunction(timeseries_data, target);

    return timeseries_data;
  }

  applyTimeShiftFunction(timeseries_data, target) {
    // Find timeShift() function and get specified interval
    let timeShiftFunc = _.find(target.functions, (func) => {
      return func.def.name === 'timeShift';
    });
    if (timeShiftFunc) {
      let shift = timeShiftFunc.params[0];
      _.forEach(timeseries_data, (series) => {
        series.datapoints = dataProcessor.unShiftTimeSeries(shift, series.datapoints);
      });
    }
  }

  queryTextData(target, timeRange) {
    let [timeFrom, timeTo] = timeRange;
    let options = {
      itemtype: 'text'
    };
    return this.zabbix.getItemsFromTarget(target, options)
      .then(items => {
        if (items.length) {
          return this.zabbix.getHistory(items, timeFrom, timeTo)
          .then(history => {
            return responseHandler.handleText(history, items, target);
          });
        } else {
          return Promise.resolve([]);
        }
      });
  }

  /**
   * Test connection to Zabbix API
   * @return {object} Connection status and Zabbix API version
   */
  testDatasource() {
    let zabbixVersion;
    return this.zabbix.getVersion()
    .then(version => {
      zabbixVersion = version;
      return this.zabbix.login();
    })
    .then(() => {
      return {
        status: "success",
        title: "Success",
        message: "Zabbix API version: " + zabbixVersion
      };
    })
    .catch(error => {
      if (error instanceof ZabbixAPIError) {
        return {
          status: "error",
          title: error.message,
          message: error.data
        };
      } else {
        return {
          status: "error",
          title: "Connection failed",
          message: "Could not connect to given url"
        };
      }
    });
  }

  ////////////////
  // Templating //
  ////////////////

  /**
   * Find metrics from templated request.
   *
   * @param  {string} query Query from Templating
   * @return {string}       Metric name - group, host, app or item or list
   *                        of metrics in "{metric1,metcic2,...,metricN}" format.
   */
  metricFindQuery(query) {
    let result;
    let parts = [];

    // Split query. Query structure: group.host.app.item
    _.each(utils.splitTemplateQuery(query), part => {
      part = this.replaceTemplateVars(part, {});

      // Replace wildcard to regex
      if (part === '*') {
        part = '/.*/';
      }
      parts.push(part);
    });
    let template = _.zipObject(['group', 'host', 'app', 'item'], parts);

    // Get items
    if (parts.length === 4) {
      // Search for all items, even it's not belong to any application
      if (template.app === '/.*/') {
        template.app = '';
      }
      result = this.zabbix.getItems(template.group, template.host, template.app, template.item);
    } else if (parts.length === 3) {
      // Get applications
      result = this.zabbix.getApps(template.group, template.host, template.app);
    } else if (parts.length === 2) {
      // Get hosts
      result = this.zabbix.getHosts(template.group, template.host);
    } else if (parts.length === 1) {
      // Get groups
      result = this.zabbix.getGroups(template.group);
    } else {
      result = Promise.resolve([]);
    }

    return result.then(metrics => {
      return _.map(metrics, formatMetric);
    });
  }

  /////////////////
  // Annotations //
  /////////////////

  annotationQuery(options) {
    var timeFrom = Math.ceil(dateMath.parse(options.rangeRaw.from) / 1000);
    var timeTo = Math.ceil(dateMath.parse(options.rangeRaw.to) / 1000);
    var annotation = options.annotation;
    var showOkEvents = annotation.showOkEvents ? c.SHOW_ALL_EVENTS : c.SHOW_OK_EVENTS;

    // Show all triggers
    let triggersOptions = {
      showTriggers: c.SHOW_ALL_TRIGGERS,
      hideHostsInMaintenance: false
    };

    var getTriggers = this.zabbix.getTriggers(this.replaceTemplateVars(annotation.group, {}),
                                              this.replaceTemplateVars(annotation.host, {}),
                                              this.replaceTemplateVars(annotation.application, {}),
                                              triggersOptions);

    return getTriggers.then(triggers => {

      // Filter triggers by description
      if (utils.isRegex(annotation.trigger)) {
        triggers = _.filter(triggers, trigger => {
          return utils.buildRegex(annotation.trigger).test(trigger.description);
        });
      } else if (annotation.trigger) {
        triggers = _.filter(triggers, trigger => {
          return trigger.description === annotation.trigger;
        });
      }

      // Remove events below the chose severity
      triggers = _.filter(triggers, trigger => {
        return Number(trigger.priority) >= Number(annotation.minseverity);
      });

      var objectids = _.map(triggers, 'triggerid');
      return this.zabbix
        .getEvents(objectids, timeFrom, timeTo, showOkEvents)
        .then(events => {
          var indexedTriggers = _.keyBy(triggers, 'triggerid');

          // Hide acknowledged events if option enabled
          if (annotation.hideAcknowledged) {
            events = _.filter(events, event => {
              return !event.acknowledges.length;
            });
          }

          return _.map(events, event => {
            let tags;
            if (annotation.showHostname) {
              tags = _.map(event.hosts, 'name');
            }

            // Show event type (OK or Problem)
            let title = Number(event.value) ? 'Problem' : 'OK';

            let formatted_acknowledges = utils.formatAcknowledges(event.acknowledges);
            return {
              annotation: annotation,
              time: event.clock * 1000,
              title: title,
              tags: tags,
              text: indexedTriggers[event.objectid].description + formatted_acknowledges
            };
          });
        });
    });
  }

  /**
   * Get triggers and its details for panel's targets
   * Returns alert state ('ok' if no fired triggers, or 'alerting' if at least 1 trigger is fired)
   * or empty object if no related triggers are finded.
   */
  alertQuery(options) {
    let enabled_targets = filterEnabledTargets(options.targets);
    let getPanelItems = _.map(enabled_targets, target => {
      return this.zabbix.getItemsFromTarget(target, {itemtype: 'num'});
    });

    return Promise.all(getPanelItems)
    .then(results => {
      let items = _.flatten(results);
      let itemids = _.map(items, 'itemid');

      return this.zabbix.getAlerts(itemids);
    })
    .then(triggers => {
      triggers = _.filter(triggers, trigger => {
        return trigger.priority >= this.alertingMinSeverity;
      });

      if (!triggers || triggers.length === 0) {
        return {};
      }

      let state = 'ok';

      let firedTriggers = _.filter(triggers, {value: '1'});
      if (firedTriggers.length) {
        state = 'alerting';
      }

      let thresholds = _.map(triggers, trigger => {
        return getTriggerThreshold(trigger.expression);
      });

      return {
        panelId: options.panelId,
        state: state,
        thresholds: thresholds
      };
    });
  }

  // Replace template variables
  replaceTargetVariables(target, options) {
    let parts = ['group', 'host', 'application', 'item'];
    _.forEach(parts, p => {
      if (target[p] && target[p].filter) {
        target[p].filter = this.replaceTemplateVars(target[p].filter, options.scopedVars);
      }
    });
    target.textFilter = this.replaceTemplateVars(target.textFilter, options.scopedVars);

    _.forEach(target.functions, func => {
      func.params = _.map(func.params, param => {
        if (typeof param === 'number') {
          return +this.templateSrv.replace(param.toString(), options.scopedVars);
        } else {
          return this.templateSrv.replace(param, options.scopedVars);
        }
      });
    });
  }

  isUseTrends(timeRange) {
    let [timeFrom, timeTo] = timeRange;
    let useTrendsFrom = Math.ceil(dateMath.parse('now-' + this.trendsFrom) / 1000);
    let useTrendsRange = Math.ceil(utils.parseInterval(this.trendsRange) / 1000);
    let useTrends = this.trends && (
      (timeFrom <= useTrendsFrom) ||
      (timeTo - timeFrom >= useTrendsRange)
    );
    return useTrends;
  }
}

function bindFunctionDefs(functionDefs, category) {
  var aggregationFunctions = _.map(metricFunctions.getCategories()[category], 'name');
  var aggFuncDefs = _.filter(functionDefs, function(func) {
    return _.includes(aggregationFunctions, func.def.name);
  });

  return _.map(aggFuncDefs, function(func) {
    var funcInstance = metricFunctions.createFuncInstance(func.def, func.params);
    return funcInstance.bindFunction(dataProcessor.metricFunctions);
  });
}

function downsampleSeries(timeseries_data, options) {
  return _.map(timeseries_data, timeseries => {
    if (timeseries.datapoints.length > options.maxDataPoints) {
      timeseries.datapoints = dataProcessor
        .groupBy(options.interval, dataProcessor.AVERAGE, timeseries.datapoints);
    }
    return timeseries;
  });
}

function formatMetric(metricObj) {
  return {
    text: metricObj.name,
    expandable: false
  };
}

/**
 * Custom formatter for template variables.
 * Default Grafana "regex" formatter returns
 * value1|value2
 * This formatter returns
 * (value1|value2)
 * This format needed for using in complex regex with
 * template variables, for example
 * /CPU $cpu_item.*time/ where $cpu_item is system,user,iowait
 */
function zabbixTemplateFormat(value) {
  if (typeof value === 'string') {
    return utils.escapeRegex(value);
  }

  var escapedValues = _.map(value, utils.escapeRegex);
  return '(' + escapedValues.join('|') + ')';
}

/**
 * If template variables are used in request, replace it using regex format
 * and wrap with '/' for proper multi-value work. Example:
 * $variable selected as a, b, c
 * We use filter $variable
 * $variable    -> a|b|c    -> /a|b|c/
 * /$variable/  -> /a|b|c/  -> /a|b|c/
 */
function replaceTemplateVars(templateSrv, target, scopedVars) {
  var replacedTarget = templateSrv.replace(target, scopedVars, zabbixTemplateFormat);
  if (target !== replacedTarget && !utils.isRegex(replacedTarget)) {
    replacedTarget = '/^' + replacedTarget + '$/';
  }
  return replacedTarget;
}

// Apply function one by one:
// sequence([a(), b(), c()]) = c(b(a()));
function sequence(funcsArray) {
  return function(result) {
    for (var i = 0; i < funcsArray.length; i++) {
      result = funcsArray[i].call(this, result);
    }
    return result;
  };
}

function filterEnabledTargets(targets) {
  return _.filter(targets, target => {
    return !(target.hide || !target.group || !target.host || !target.item);
  });
}

function getTriggerThreshold(expression) {
  let thresholdPattern = /.*[<>]([\d\.]+)/;
  let finded_thresholds = expression.match(thresholdPattern);
  if (finded_thresholds && finded_thresholds.length >= 2) {
    let threshold = finded_thresholds[1];
    threshold = Number(threshold);
    return threshold;
  } else {
    return null;
  }
}

export {ZabbixAPIDatasource, zabbixTemplateFormat};

// Fix for backward compatibility with lodash 2.4
if (!_.includes) {_.includes = _.contains;}
if (!_.keyBy) {_.keyBy = _.indexBy;}
