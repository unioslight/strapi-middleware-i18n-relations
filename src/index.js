module.exports = (config, { strapi }) => {
  const isAcceptedMethod = (ctx) =>
    ["PUT", "POST"].includes(ctx.request?.method);

  const getContentConfig = (ctx) => {
    const typeConfig = config.types.find((type) =>
      ctx.request?.url?.includes(type.api)
    );
    if (!typeConfig) return null;
    return typeConfig;
  };

  /**
   * Reduce fields to a populate object with localizations also requested.
   * @param {*} contentConfig
   * @returns
   */
  const getPopulate = (contentConfig) => {
    const { rootRelations, componentRelations, dynamicRelations } =
      contentConfig;
    let populate = {};

    // Root relations
    if (rootRelations) {
      populate = rootRelations.reduce(
        (acc, fieldKey) => ({
          ...acc,
          [fieldKey]: { populate: "*" },
        }),
        populate
      );
    }

    // Component relations
    if (componentRelations) {
      populate = componentRelations.reduce((acc, component) => {
        const { componentField, relationField } = component;
        return {
          ...acc,
          [componentField]: {
            populate: { [relationField]: { populate: "*" } },
          },
        };
      }, populate);
    }

    // Dynamic content relations
    if (dynamicRelations) {
      populate = dynamicRelations.reduce((acc, component) => {
        const { dynamicField, repeatingComponentField, relationField } =
          component;

        let dynamicFieldObject = acc[dynamicField] || { populate: {} };
        const relationPop = { [relationField]: { populate: "*" } };

        if (repeatingComponentField) {
          dynamicFieldObject.populate = {
            ...dynamicFieldObject.populate,
            [repeatingComponentField]: {
              populate: relationPop,
            },
          };
        } else {
          dynamicFieldObject.populate = {
            ...dynamicFieldObject.populate,
            ...relationPop,
          };
        }

        return {
          ...acc,
          [dynamicField]: dynamicFieldObject,
        };
      }, populate);
    }

    return populate;
  };

  /**
   * Returns the id and string prefix of localization items
   * (locale versions of the same content item)
   * @param {*} api
   * @param {*} localizationIds
   * @returns
   */
  const findOtherLocalizations = async (api, localizationIds, populate) =>
    await strapi.entityService.findMany(api, {
      filters: {
        id: { $in: localizationIds },
      },
      locale: "all",
      populate,
      publicationState: "preview", //Grab all items regardless of state - they may be in progress
    });
  /**
   * Returns the en localization version for this content item
   * @param {*} api
   * @param {*} localizationIds
   * @param {*} populate
   * @returns
   */
  const findDefaultLocalization = async (api, localizationIds, populate) => {
    const result = await strapi.entityService.findMany(api, {
      filters: {
        id: { $in: localizationIds },
      },
      populate,
      locale: config.defaultLocale,
      publicationState: "preview", //Grab all items regardless of state - it may be in progress
    });
    if (result.length) {
      return result[0];
    } else {
      console.warn(
        `Could not find default localization in i18n relations middleweare. Params:`,
        { api, localizations: localizationIds }
      );
      return null;
    }
  };

  /**
   * Builds data payload for updating an entity with relations from the enLocalization
   * @param {*} contentConfig
   * @param {*} localeShortCode
   * @param {*} defaultLocalization
   * @param {*} targetLocalization Required for dynamic content zone updates
   */

  const buildRelationsData = (
    contentConfig,
    localeShortCode,
    defaultLocalization,
    targetLocalization
  ) => {
    let data = {};

    // For root relations
    if (contentConfig.rootRelations) {
      data = contentConfig.rootRelations.reduce((acc, relationField) => {
        try {
          let newDataProperty;
          const defaultRelation = defaultLocalization[relationField];
          const isLocalized = Array.isArray(defaultRelation)
            ? !!defaultRelation[0]?.localizations
            : !!defaultRelation?.localizations;

          if (Array.isArray(defaultRelation)) {
            //For arrays, this is a many-to-many or many-to-one relationship, so for each we need to use its matching localization
            if (isLocalized) {
              // IMPORTANT: This does not know if your relation is many-to-many or many-to-one.
              // If your localised relation is constrained to a single relation (many to one), the relation will only save on one localisation!
              // Recommended approach is to ensure a relationship is localised both sides
              newDataProperty = defaultRelation.map(
                (relation) =>
                  relation.localizations.find((relationLocalization) => {
                    return relationLocalization.locale === localeShortCode;
                  })?.id //Grab the Id. For the root many-to-many relations, we allow optional chaining to catch null localizations, but we still want the other relations with a localization ready to still populate
              );
            } else {
              newDataProperty = defaultRelation.map((relation) => relation.id);
            }
          } else {
            //Objects are a one-to-one or one-to-many, so just need to grab the localization property
            if (isLocalized) {
              newDataProperty = defaultRelation.localizations.find(
                (relationLocalization) =>
                  relationLocalization.locale === localeShortCode
              ).id;
            } else {
              newDataProperty = defaultRelation.id;
            }
          }

          if (!newDataProperty) return acc;

          //Strip nullish. (many-to-many version)
          if (Array.isArray(newDataProperty)) {
            newDataProperty = newDataProperty.filter((x) => !!x);
          }

          return {
            ...acc,
            [relationField]: newDataProperty,
          };
        } catch (error) {
          console.error(
            `I18N middleware error while reducing root field "${relationField}". Check all relations have a localization saved for this target locale.`,
            error
          );
          return acc;
        }
      }, data);
    }
    // For component relations (AKA "orderable" components)
    if (contentConfig.componentRelations) {
      data = contentConfig.componentRelations.reduce((acc, component) => {
        try {
          const { componentField, relationField } = component;
          let newDataProperty;

          const defaultComponent = defaultLocalization[componentField];
          if (!defaultComponent) return acc;

          // It's possible that a relation could be within a component that is not repeatable.
          // However, we assume a component relation is always a repeatable one.
          // At Unios, the use case of a relation in a repeatable component is to achieve orderable relations
          // Non-repeating relations should be set up on the root....
          // Just throw a warning and skedaddle if it's not an array
          if (!Array.isArray(defaultComponent)) {
            console.warn(
              `I18N middleware Warning: Repeatable component is expected while building a component relationship in payload (component "${componentField}" value was not an array). 
        If not repeatable, set up the relationship at the collection type\'s root level. componentField: `,
              contentConfig
            );
            return acc;
          }

          // Skip if empty
          if (!defaultComponent.length) return acc;

          // Also in fitting with the Unios use case... the actual relation field should not be an array. It should be a one-to-one or one-to-many relationship
          // If this becomes a required future use case, let's handle it then, but for now we aren't handling this structure
          if (Array.isArray(defaultComponent[0][relationField])) {
            console.warn(
              `I18N middleware Warning: Repeatable component relationship is expected to be one-to-one or one-to-many (component "${componentField}" has many relationships).
        Make the relationship one-to-one or one-to-many in the Strapi component configuration. Config: `,
              contentConfig
            );
            return acc;
          }

          // Now, check if the relationship is localized.
          // Again, we expect an array of components, and know one exists so just go straight to the localizations property on the first item
          const isLocalized =
            !!defaultComponent[0][relationField].localizations;

          if (isLocalized) {
            newDataProperty = defaultComponent.map((componentItem) => {
              const match = componentItem[relationField].localizations.find(
                (relationLocalization) => {
                  return relationLocalization.locale === localeShortCode;
                }
              );
              if (!match) return undefined;
              return { [relationField]: match.id };
            });
          } else {
            newDataProperty = defaultComponent.map((componentItem) => ({
              [relationField]: componentItem[relationField].id,
            }));
          }

          if (!newDataProperty) return acc;

          return {
            ...acc,
            [componentField]: newDataProperty,
          };
        } catch (error) {
          console.error(
            `I18N middleware error while reducing component field "${component}". Check all relations have a localization saved for this target locale.`,
            error
          );
          return acc;
        }
      }, data);
    }
    // For dynamic content relations
    if (contentConfig.dynamicRelations && targetLocalization) {
      // Something special - for dynamic content, we need to use the target localization fetch the existing content for this locale.
      // We can't dump default locale content into the new locale without matching it up to the IDs of existing content...
      data = contentConfig.dynamicRelations.reduce((acc, component) => {
        try {
          const {
            dynamicField, //Almost always 'dynamicContent' in our case
            componentField, //TODO: Change to componentValue/Name
            repeatingComponentField,
            relationField,
          } = component;

          const defaultDynamicZone = defaultLocalization[dynamicField];
          if (!defaultDynamicZone) return acc;

          // Pull out the existing dynamic zone in the current reduced data set.
          // This will be the paylaod for this particular dynamic zone property on the strapi update
          // IMPORTANT: If it doesn't exist, pre-populate with the current target data otherwise it is lost!
          // prettier-ignore
          let dynamicFieldArr = acc[dynamicField] || targetLocalization[dynamicField];

          // Determine if this dynamic zone relation localized
          // No optional chaining null catches here - we want it to crap out if anything isn't provided
          const firstMatch = defaultDynamicZone.find((dynamicComponent) =>
            dynamicComponent.__component?.includes(componentField)
          );
          // prettier-ignore
          const isLocalized = !!repeatingComponentField
            ? !!firstMatch[repeatingComponentField][0][relationField].localizations
            : !!firstMatch[relationField].localizations;

          //Begin sweeping through the current dynamic content, looking for instances of this component
          dynamicFieldArr = dynamicFieldArr.map((dynamicComponent, index) => {
            if (!dynamicComponent.__component?.includes(componentField)) {
              //Not the correct component type, leave as is
              return dynamicComponent;
            }

            //Check this component aligns correctly between the default localization and the current target localization.
            // prettier-ignore
            if (!defaultDynamicZone[index].__component.includes(componentField)
            ) {
              console.error(
                `I18N middleware Warning: Dynamic content relationships "${relationField}" on dynamic zone component ${componentField} cannot be updated: Component mismatch between default and target localization "${localeShortCode}".
                Update other locales with matching dynamic content zone entries to resolve.
                `
              );
              return dynamicComponent;
            }
            if (!!repeatingComponentField) {
              // This config has a repeating component within to handle...
              // EG: Project hotspot gallery has nested hotspot images as an array, and the relation is within
              if (!isLocalized) {
                {
                  // prettier-ignore
                  return {
                    ...dynamicComponent,
                    [repeatingComponentField]: dynamicComponent[repeatingComponentField].map((repeatingComponent, repeatingComponentIndex) => ({
                      ...repeatingComponent,
                      [relationField]: {
                        id: defaultDynamicZone[index][repeatingComponentField][repeatingComponentIndex][relationField].id,
                      },
                    })),
                  };
                }
              } else {
                // prettier-ignore
                return {
                  ...dynamicComponent,
                  [repeatingComponentField]: dynamicComponent[repeatingComponentField].map((repeatingComponent, repeatingComponentIndex) => {
                    return {
                      ...repeatingComponent,
                      [relationField]: {
                        id: defaultDynamicZone[index][repeatingComponentField][repeatingComponentIndex][relationField].localizations.find(
                          ({ locale }) => locale === localeShortCode
                        ).id,
                      },
                    };
                  }),
                };
              }
            } else {
              // No repeating nested component
              // EG: Project hotspot image section has a single hotspot image relation within
              if (!isLocalized) {
                return {
                  ...dynamicComponent,
                  [relationField]: {
                    id: defaultDynamicZone[index][relationField].id,
                  },
                };
              } else {
                // prettier-ignore

                return {
                  ...dynamicComponent,
                  [relationField]: defaultDynamicZone[index][relationField].localizations.find(
                    ({ locale }) => locale === localeShortCode
                  ).id, ///in the default set, get the array of Ids that match the locale we are updating
                };
              }
            }
          });
          if (!dynamicFieldArr) return acc;
          return {
            ...acc,
            [dynamicField]: dynamicFieldArr,
          };
        } catch (error) {
          console.error(
            `I18N middleware error while reducing dynamic components field. Check all relations have a localization saved for this target locale.`,
            error
          );
          return acc;
        }
      }, data);
    }

    return data;
  };

  return async (ctx, next) => {
    await next();

    // Context logging
    // console.log("ctx.request.body: ", ctx.request.body);
    // console.log("ctx.response.body: ", ctx.response.body);

    //Check current request's api is handled
    const contentConfig = getContentConfig(ctx);
    const { defaultLocale } = config;
    if (!contentConfig) return;
    const populate = getPopulate(contentConfig);

    //Run middleware only for accepted requests
    if (!isAcceptedMethod(ctx)) {
      return;
    }

    //Try to populate some specific relations on other localizations
    const { id, localizations, locale } = ctx.response.body;

    //can't proceed without a list of localizations on this request
    if (!localizations?.length) return;

    const { api } = contentConfig;
    const localizationIds = localizations.map((l) => l.id);
    if (locale === defaultLocale) {
      // If en version, populate to other localizations
      // Current update request should have all the data we need
      const enLocalization = await findDefaultLocalization(api, [id], populate);

      const otherLocalizations = await findOtherLocalizations(
        api,
        localizationIds,
        populate
      );

      for (const otherLocalization of otherLocalizations) {
        const { locale } = otherLocalization;

        const data = buildRelationsData(
          contentConfig,
          locale,
          enLocalization,
          otherLocalization
        );
        console.log(
          `${defaultLocale} localization updated. Applying relations data for ${locale}: `,
          data
        );
        await strapi.entityService.update(api, otherLocalization.id, {
          data,
        });
      }
    } else {
      // A non 'en' locale is being saved.
      // get the en localization,
      // populate this item with appropriate relationships matching this locale
      const defaultLocalization = await findDefaultLocalization(
        api,
        localizationIds,
        populate
      );
      if (!defaultLocalization) return;
      const otherLocalization = ctx.response.body;

      const data = buildRelationsData(
        contentConfig,
        locale,
        defaultLocalization,
        otherLocalization
      );
      console.log(`Relations data for ${locale} on update: `, data);

      await strapi.entityService.update(api, id, {
        data,
      });
    }
  };
};
