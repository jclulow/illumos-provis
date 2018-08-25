

NAME :=				provis

NODE_PREBUILT_TAG =		gz
NODE_PREBUILT_VERSION =		v6.14.3
NODE_PREBUILT_IMAGE =		18b094b0-eb01-11e5-80c1-175dac7ddf02

NODE_DEV_SYMLINK =		node

PROTO =				proto
PREFIX =			/opt/$(NAME)

CLEAN_FILES +=			$(PROTO)

include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node_prebuilt.defs
include ./tools/mk/Makefile.node_modules.defs

.PHONY: all
all: $(STAMP_NODE_PREBUILT) $(STAMP_NODE_MODULES)
	$(NODE) --version

#
# Install macros and targets:
#

COMMANDS =			$(subst .js,,$(notdir $(wildcard cmd/*.js)))

LIB_FILES =			$(notdir $(wildcard lib/*.js))

SMF_MANIFESTS =			$(subst .json,,$(notdir $(wildcard smf/*.json)))

NODE_BITS =			bin/node \
				lib/libgcc_s.so.1 \
				lib/libstdc++.so.6
NODE_DIR =			$(PREFIX)/node
NODE_MODULE_INSTALL =		$(PREFIX)/node_modules/.ok

INSTALL_FILES =			$(addprefix $(PROTO), \
				$(NODE_BITS:%=$(NODE_DIR)/%) \
				$(NODE_MODULE_INSTALL) \
				$(COMMANDS:%=$(PREFIX)/cmd/%.js) \
				$(COMMANDS:%=$(PREFIX)/bin/%) \
				$(LIB_FILES:%=$(PREFIX)/lib/%) \
				$(PREFIX)/lib/wrap.sh \
				$(SMF_MANIFESTS:%=$(PREFIX)/smf/%.xml) \
				)

INSTALL_DIRS =			$(addprefix $(PROTO), \
				$(PREFIX)/bin \
				$(PREFIX)/cmd \
				$(PREFIX)/lib \
				$(PREFIX)/var \
				$(PREFIX)/smf \
				$(NODE_DIR)/bin \
				$(NODE_DIR)/lib \
				)

INSTALL_EXEC =			rm -f $@ && cp $< $@ && chmod 755 $@
INSTALL_FILE =			rm -f $@ && cp $< $@ && chmod 644 $@

.PHONY: install
install: $(INSTALL_FILES)

$(INSTALL_DIRS):
	mkdir -p $@

$(PROTO)$(PREFIX)/node/bin/%: $(STAMP_NODE_PREBUILT) | $(INSTALL_DIRS)
	rm -f $@ && cp $(NODE_INSTALL)/node/bin/$(@F) $@ && chmod 755 $@

$(PROTO)$(PREFIX)/node/lib/%: $(STAMP_NODE_PREBUILT) | $(INSTALL_DIRS)
	rm -f $@ && cp $(NODE_INSTALL)/node/lib/$(@F) $@ && chmod 644 $@

$(PROTO)$(PREFIX)/cmd/%.js: cmd/%.js | $(INSTALL_DIRS)
	$(INSTALL_FILE)

$(PROTO)$(PREFIX)/bin/%:
	rm -f $@ && ln -s ../lib/wrap.sh $@

$(PROTO)$(PREFIX)/lib/%.sh: lib/%.sh | $(INSTALL_DIRS)
	$(INSTALL_EXEC)

$(PROTO)$(PREFIX)/lib/%.js: lib/%.js | $(INSTALL_DIRS)
	$(INSTALL_FILE)

$(PROTO)$(NODE_MODULE_INSTALL): $(STAMP_NODE_MODULES) | $(INSTALL_DIRS)
	rm -rf $(@D)/
	cp -rP node_modules/ $(@D)/
	touch $@

$(PROTO)$(PREFIX)/smf/%.xml: smf/%.json | $(STAMP_NODE_MODULES) $(INSTALL_DIRS)
	sed -e 's,PREFIX,$(PREFIX),g' $< | $(NODE) node_modules/.bin/smfgen > $@

#
# Check targets:
#

CHECK_JS_FILES =		$(wildcard cmd/*.js) \
				$(wildcard lib/*.js)

.PHONY: check
check::
	jshint $(CHECK_JS_FILES)


include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.targ
include ./tools/mk/Makefile.node_prebuilt.targ
include ./tools/mk/Makefile.node_modules.targ
