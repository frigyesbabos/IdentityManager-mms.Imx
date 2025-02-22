/*
 * ONE IDENTITY LLC. PROPRIETARY INFORMATION
 *
 * This software is confidential.  One Identity, LLC. or one of its affiliates or
 * subsidiaries, has supplied this software to you under terms of a
 * license agreement, nondisclosure agreement or both.
 *
 * You may not copy, disclose, or use this software except in accordance with
 * those terms.
 *
 *
 * Copyright 2023 One Identity LLC.
 * ALL RIGHTS RESERVED.
 *
 * ONE IDENTITY LLC. MAKES NO REPRESENTATIONS OR
 * WARRANTIES ABOUT THE SUITABILITY OF THE SOFTWARE,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE IMPLIED WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE, OR
 * NON-INFRINGEMENT.  ONE IDENTITY LLC. SHALL NOT BE
 * LIABLE FOR ANY DAMAGES SUFFERED BY LICENSEE
 * AS A RESULT OF USING, MODIFYING OR DISTRIBUTING
 * THIS SOFTWARE OR ITS DERIVATIVES.
 *
 */

import { ChangeDetectorRef, Component, Inject, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { AbstractControl, UntypedFormArray, UntypedFormBuilder, UntypedFormGroup } from '@angular/forms';
import { EuiLoadingService, EuiSidesheetRef, EUI_SIDESHEET_DATA } from '@elemental-ui/core';
import _ from 'lodash';

import { ListReportDefinitionDto, ListReportDefinitionRead, PortalReportsEdit } from 'imx-api-rps';
import {
  ExtendedTypedEntityCollection,
  SqlWizardExpression,
  isExpressionInvalid,
  ValType,
  FkProviderItem,
  SqlExpression,
} from 'imx-qbm-dbts';

import {
  BaseCdr,
  ColumnDependentReference,
  ConfirmationService,
  EntityService,
  SnackBarService,
  SqlWizardComponent,
  CdrFactoryService,
  BaseReadonlyCdr,
} from 'qbm';
import { ProjectConfigurationService } from 'qer';
import { Subscription } from 'rxjs';
import { RpsApiService } from '../../rps-api-client.service';
import { EditReportSqlWizardService } from '../editreport-sqlwizard.service';

@Component({
  templateUrl: './edit-report-sidesheet.component.html',
  styleUrls: ['./edit-report-sidesheet.component.scss'],
})
export class EditReportSidesheetComponent implements OnInit, OnDestroy {
  public get formArray(): UntypedFormArray {
    return this.detailsFormGroup.get('formArray') as UntypedFormArray;
  }
  public cdrList: ColumnDependentReference[] = [];
  public readonly detailsFormGroup: UntypedFormGroup;

  public get sqlExpression(): SqlWizardExpression {
    return this.definition?.Data;
  }
  public definition: ListReportDefinitionDto;
  public report: PortalReportsEdit;

  public ldsUnsupportedExpression = '#LDS#You cannot edit the conditions of this report in the Web Portal.';

  public ldsAllRowsInfoText = '#LDS#All data from the selected table will be included in the report.';

  public get controlsInvalid(): boolean {
    return (
      (this.detailsFormGroup.pristine && this.exprHasntChanged) ||
      this.detailsFormGroup.invalid ||
      (!this.sqlExpression?.IsUnsupported && this.isConditionInvalid())
    );
  }

  private closeSubscription: Subscription;

  public lastSavedExpression: SqlExpression;
  public exprHasntChanged = true;

  public checkChanges(expression: SqlExpression): void {
    this.exprHasntChanged = _.isEqual(expression, this.lastSavedExpression);
    if (!this.exprHasntChanged) {
      this.sqlExpression.Expression = expression;
    }
  }

  @ViewChild(SqlWizardComponent) private sqlwizard: SqlWizardComponent;

  constructor(
    formBuilder: UntypedFormBuilder,
    public readonly svc: EditReportSqlWizardService,
    @Inject(EUI_SIDESHEET_DATA)
    public data: {
      report: ExtendedTypedEntityCollection<PortalReportsEdit, ListReportDefinitionRead>;
      isNew: boolean;
      isReadonly: boolean;
    },
    private readonly snackBar: SnackBarService,
    private readonly sideSheetRef: EuiSidesheetRef,
    private readonly api: RpsApiService,
    private readonly entityService: EntityService,
    private readonly busyService: EuiLoadingService,
    private readonly cdref: ChangeDetectorRef,
    private readonly config: ProjectConfigurationService,
    private readonly cdrFactoryService: CdrFactoryService,
    confirmation: ConfirmationService
  ) {
    this.detailsFormGroup = new UntypedFormGroup({ formArray: formBuilder.array([]) });

    this.closeSubscription = this.sideSheetRef.closeClicked().subscribe(async () => {
      if ((!this.detailsFormGroup.dirty && this.exprHasntChanged) || (await confirmation.confirmLeaveWithUnsavedChanges())) {
        this.sideSheetRef.close();
      }
    });

    this.report = data.report.Data[0];

    // Save a local copy of the definition object. The entity will change with every update
    // of the interactive entity that comes back from the server
    this.definition = this.report.extendedDataRead?.Definition[0];

    this.lastSavedExpression = _.cloneDeep(this.sqlExpression?.Expression);
  }

  public async ngOnInit(): Promise<void> {
    const c = await this.config.getConfig();

    this.cdrList = this.cdrFactoryService.buildCdrFromColumnList(
      this.report.GetEntity(),
      c.OwnershipConfig.EditableFields[this.report.GetEntity().TypeName],
      this.data.isReadonly
    );

    if (this.definition) {
      // is it a list report?
      this.cdrList.push(await this.buildTableCdr());
    }
    this.cdrList.push(
      this.data.isReadonly ? new BaseReadonlyCdr(this.report.AvailableTo.Column) : new BaseCdr(this.report.AvailableTo.Column)
    );
  }

  public addCdr(control: AbstractControl): void {
    this.formArray.push(control);
    this.cdref.detectChanges();
  }

  public ngOnDestroy(): void {
    if (this.closeSubscription) {
      this.closeSubscription.unsubscribe();
    }
  }

  public async save(): Promise<void> {
    if (!this.detailsFormGroup.valid) {
      return;
    }

    const busy = this.busyService.show();
    try {
      if (this.definition) {
        this.report.extendedData = {
          Definition: [
            {
              SelectedColumns: this.definition.SelectedColumns,
              Data: {
                Filters: [this.definition.Data.Expression],
              },
            },
          ],
        };
      }

      await this.report.GetEntity().Commit(false);
      this.detailsFormGroup.markAsPristine();
      this.sideSheetRef.close(true);
      this.snackBar.open({ key: '#LDS#The report has been successfully saved.' });
    } finally {
      this.busyService.hide(busy);
    }
  }

  public isConditionInvalid(): boolean {
    if (!this.definition) {
      return false;
    } // not a list report?

    if (this.definition.SelectedColumns.filter((elem) => elem != null && elem !== '').length < 1) {
      return true;
    } // must select at least one column

    // not initialized? avoid NG1000
    if (!this.sqlwizard || !this.sqlwizard.viewSettings) {
      return true;
    }

    // check if the sqlWizard has a valid expression
    return isExpressionInvalid(this.sqlExpression) || !this.hasValuesSet(this.sqlExpression.Expression);
  }

  private hasValuesSet(sqlExpression: SqlExpression, checkCurrent: boolean = false): boolean {
    const current = !checkCurrent || sqlExpression.Value != null;

    if (sqlExpression.Expressions?.length > 0) {
      return current && sqlExpression.Expressions.every((elem) => this.hasValuesSet(elem, true));
    }

    return current;
  }

  private async buildTableCdr(): Promise<BaseCdr> {
    const fkProviderItem: FkProviderItem = {
      columnName: 'uid_dialogtable',
      fkTableName: 'DialogTable',
      parameterNames: ['search'],
      load: async (_, parameters?) => {
        return this.api.client.portal_reports_tables_get(parameters);
      },
      getDataModel: async (_) => {
        return {};
      },
    };

    const tableCol = this.entityService.createLocalEntityColumn(
      {
        ColumnName: fkProviderItem.columnName,
        Type: ValType.String,
        FkRelation: {
          IsMemberRelation: false,
          ParentTableName: fkProviderItem.fkTableName,
          ParentColumnName: 'TableName',
        },
        ValidReferencedTables: [{ TableName: fkProviderItem.fkTableName }],
        MinLen: 1,
      },
      [fkProviderItem]
    );
    await tableCol.PutValueStruct({
      DataValue: this.definition.TableName,
      DisplayValue: this.definition.TableNameDisplay,
    });
    tableCol.ColumnChanged.subscribe(async () => {
      // send an extended data update to the server, wait for the updated column object to get back
      await this.report.setExtendedData({
        Definition: [
          {
            TableName: tableCol.GetValue(),
          },
        ],
      });
      this.definition = this.report.extendedDataRead?.Definition[0];
      this.cdref.detectChanges();
    });

    const tableCdr = this.data.isReadonly
      ? new BaseReadonlyCdr(tableCol, '#LDS#Include data from the table')
      : new BaseCdr(tableCol, '#LDS#Include data from the table');
    return tableCdr;
  }
}
